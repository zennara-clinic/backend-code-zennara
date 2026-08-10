#!/usr/bin/env python3
"""Read-only Zenoti guest/customer lookup utility.

Run from the Backend directory. The script reads ``.env`` automatically and
uses only Python's standard library, so no pip install is required.

Examples:
    python3 scripts/zenoti_guest_test.py --check
    python3 scripts/zenoti_guest_test.py --phone 9876543210
    python3 scripts/zenoti_guest_test.py --email customer@example.com --redact
    python3 scripts/zenoti_guest_test.py --guest-id UUID --profile-only

The script performs GET requests only. It never creates or updates Zenoti data.
Customer data is printed to the terminal unless ``--output`` is supplied.
Use ``--redact`` when sharing test output.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket
import sys
import time
from datetime import date, timedelta
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen


BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_ENV_FILE = BACKEND_DIR / ".env"
DEFAULT_API_BASE = "https://api.zenoti.com"


class ZenotiApiError(RuntimeError):
    """An HTTP or network error returned by the Zenoti API."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def load_env_file(path: Path) -> None:
    """Load a simple dotenv file without replacing exported environment vars."""
    if not path.exists():
        return

    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].lstrip()
        key, value = line.split("=", 1)
        key = key.strip()
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
            value = value[1:-1]
        os.environ.setdefault(key, value)


def response_message(body: str, fallback: str) -> str:
    """Extract a useful API error without dumping the entire response body."""
    try:
        parsed = json.loads(body)
    except (json.JSONDecodeError, TypeError):
        return fallback

    if not isinstance(parsed, dict):
        return fallback
    error = parsed.get("error")
    if isinstance(error, dict):
        return str(error.get("message") or error.get("Message") or fallback)
    return str(parsed.get("message") or parsed.get("Message") or fallback)


class ZenotiClient:
    def __init__(self, api_key: str, base_url: str, timeout: float = 20.0) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def get(self, path: str, query: dict[str, Any] | None = None) -> Any:
        params = {
            key: value
            for key, value in (query or {}).items()
            if value is not None and value != ""
        }
        url = f"{self.base_url}/{path.lstrip('/')}"
        if params:
            url = f"{url}?{urlencode(params)}"

        for attempt in range(3):
            request = Request(
                url,
                headers={
                    "Authorization": f"apikey {self.api_key}",
                    "Accept": "application/json",
                    "User-Agent": "Zennara-Zenoti-ReadOnly-Test/1.0",
                },
                method="GET",
            )
            try:
                with urlopen(request, timeout=self.timeout) as response:
                    body = response.read().decode("utf-8", errors="replace")
                    return json.loads(body) if body else None
            except HTTPError as exc:
                body = exc.read().decode("utf-8", errors="replace")
                fallback = f"Zenoti request failed with HTTP {exc.code}"
                message = response_message(body, fallback)

                if (exc.code == 429 or 500 <= exc.code < 600) and attempt < 2:
                    retry_after = exc.headers.get("Retry-After")
                    try:
                        delay = float(retry_after) if retry_after else 0.5 * (2**attempt)
                    except ValueError:
                        delay = 0.5 * (2**attempt)
                    time.sleep(min(max(delay, 0.0), 10.0))
                    continue
                raise ZenotiApiError(message, exc.code) from None
            except (URLError, TimeoutError, socket.timeout) as exc:
                if attempt < 2:
                    time.sleep(0.5 * (2**attempt))
                    continue
                reason = getattr(exc, "reason", exc)
                raise ZenotiApiError(f"Could not reach Zenoti: {reason}") from None
            except json.JSONDecodeError:
                raise ZenotiApiError("Zenoti returned a non-JSON response") from None

        raise ZenotiApiError("Zenoti request failed after retries")


def guest_list(payload: Any) -> list[dict[str, Any]]:
    if not isinstance(payload, dict):
        return []
    guests = payload.get("guests", payload.get("Guests", []))
    return guests if isinstance(guests, list) else []


def guest_id(record: dict[str, Any]) -> str | None:
    value = record.get("id") or record.get("Id") or record.get("guest_id")
    return str(value) if value else None


def phone_variants(raw_phone: str) -> list[str]:
    digits = re.sub(r"\D", "", raw_phone)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[2:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[1:]
    if not digits:
        return []
    variants = [digits]
    if len(digits) == 10:
        variants.append(f"91{digits}")
    return list(dict.fromkeys(variants))


def find_guest(
    client: ZenotiClient,
    *,
    phone: str | None,
    email: str | None,
    center_id: str | None,
) -> tuple[dict[str, Any] | None, int]:
    if phone:
        variants = phone_variants(phone)
        if not variants:
            raise ZenotiApiError("The supplied phone number has no digits")
        for variant in variants:
            payload = client.get(
                "/v1/guests/search",
                {"phone": variant, "center_id": center_id, "page": 1, "size": 100},
            )
            matches = guest_list(payload)
            if matches:
                return matches[0], len(matches)
        return None, 0

    payload = client.get(
        "/v1/guests/search",
        {"email": email, "center_id": center_id, "page": 1, "size": 100},
    )
    matches = guest_list(payload)
    return (matches[0], len(matches)) if matches else (None, 0)


SENSITIVE_KEYS = {
    "address",
    "address1",
    "address2",
    "address_1",
    "address_2",
    "anniversary_date",
    "city",
    "date_of_birth",
    "dob_incomplete_year",
    "email",
    "first_name",
    "full_name",
    "home_phone",
    "last_name",
    "middle_name",
    "mobile",
    "mobile_phone",
    "name",
    "pan",
    "phone",
    "user_name",
    "work_phone",
    "zip",
    "zip_code",
}


def redact(value: Any, parent_key: str = "") -> Any:
    """Recursively mask common customer PII fields in an API response."""
    if parent_key.lower() in SENSITIVE_KEYS:
        return "<redacted>" if value not in (None, "", [], {}) else value
    if isinstance(value, dict):
        return {key: redact(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item, parent_key) for item in value]
    return value


def fetch_section(
    client: ZenotiClient,
    path: str,
    query: dict[str, Any] | None,
    errors: dict[str, dict[str, Any]],
    section: str,
) -> Any:
    try:
        return client.get(path, query)
    except ZenotiApiError as exc:
        errors[section] = {"status": exc.status, "message": str(exc)}
        return None


def parse_date(raw: str) -> str:
    try:
        return date.fromisoformat(raw).isoformat()
    except ValueError:
        raise argparse.ArgumentTypeError("expected YYYY-MM-DD") from None


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Read-only test lookup for Zennara customers stored in Zenoti.",
    )
    lookup = parser.add_mutually_exclusive_group(required=True)
    lookup.add_argument("--check", action="store_true", help="verify API access by listing centers; fetches no customer data")
    lookup.add_argument("--phone", help="find a guest by mobile number")
    lookup.add_argument("--email", help="find a guest by email address")
    lookup.add_argument("--guest-id", help="retrieve a guest by Zenoti guest ID")
    parser.add_argument("--center-id", help="limit phone/email search to one Zenoti center")
    parser.add_argument("--profile-only", action="store_true", help="skip appointments, purchases, memberships, packages, and loyalty")
    parser.add_argument("--from-date", type=parse_date, help="appointment start date (YYYY-MM-DD; default: two years ago)")
    parser.add_argument("--to-date", type=parse_date, help="appointment end date (YYYY-MM-DD; default: 90 days ahead)")
    parser.add_argument("--redact", action="store_true", help="mask common personally identifiable fields in output")
    parser.add_argument("--output", type=Path, help="write JSON to this file instead of stdout")
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV_FILE, help="dotenv file (default: Backend/.env)")
    parser.add_argument("--timeout", type=float, default=20.0, help="per-request timeout in seconds (default: 20)")
    return parser


def main() -> int:
    args = build_parser().parse_args()
    load_env_file(args.env_file.expanduser().resolve())

    api_key = os.environ.get("ZENOTI_API_KEY", "").strip()
    if not api_key:
        print(
            f"ERROR: ZENOTI_API_KEY is missing (checked environment and {args.env_file})",
            file=sys.stderr,
        )
        return 2

    base_url = os.environ.get("ZENOTI_API_BASE", DEFAULT_API_BASE).strip()
    client = ZenotiClient(api_key, base_url, timeout=args.timeout)

    try:
        if args.check:
            payload = client.get("/v1/centers")
            centers = payload.get("centers", payload.get("Centers", [])) if isinstance(payload, dict) else []
            result: dict[str, Any] = {
                "ok": True,
                "configured": True,
                "apiBase": base_url,
                "centersCount": len(centers) if isinstance(centers, list) else None,
            }
        else:
            match_count: int | None = None
            if args.guest_id:
                selected_guest_id = args.guest_id.strip()
            else:
                match, match_count = find_guest(
                    client,
                    phone=args.phone,
                    email=args.email,
                    center_id=args.center_id,
                )
                if not match:
                    print("No matching Zenoti guest was found.", file=sys.stderr)
                    return 3
                selected_guest_id = guest_id(match)
                if not selected_guest_id:
                    raise ZenotiApiError("Zenoti search result did not contain a guest ID")

            profile = client.get(f"/v1/guests/{selected_guest_id}")
            errors: dict[str, dict[str, Any]] = {}
            result = {
                "ok": True,
                "guestId": selected_guest_id,
                "searchMatchCount": match_count,
                "profile": profile,
            }

            if not args.profile_only:
                today = date.today()
                from_date = args.from_date or (today - timedelta(days=730)).isoformat()
                to_date = args.to_date or (today + timedelta(days=90)).isoformat()
                if date.fromisoformat(from_date) > date.fromisoformat(to_date):
                    print("ERROR: --from-date must be on or before --to-date", file=sys.stderr)
                    return 2

                guest_path = f"/v1/guests/{selected_guest_id}"
                result.update(
                    {
                        "appointmentWindow": {"from": from_date, "to": to_date},
                        "appointments": fetch_section(
                            client,
                            f"{guest_path}/appointments",
                            {"start_date": from_date, "end_date": to_date},
                            errors,
                            "appointments",
                        ),
                        "productPurchases": fetch_section(
                            client, f"{guest_path}/products", None, errors, "productPurchases"
                        ),
                        "memberships": fetch_section(
                            client, f"{guest_path}/memberships", None, errors, "memberships"
                        ),
                        "packages": fetch_section(
                            client, f"{guest_path}/packages", None, errors, "packages"
                        ),
                        "loyalty": fetch_section(
                            client, f"{guest_path}/loyaltypoints", None, errors, "loyalty"
                        ),
                    }
                )
                if errors:
                    result["sectionErrors"] = errors

        if args.redact:
            result = redact(result)
        rendered = json.dumps(result, indent=2, ensure_ascii=False, default=str) + "\n"
        if args.output:
            output_path = args.output.expanduser().resolve()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text(rendered, encoding="utf-8")
            print(f"Wrote {'redacted ' if args.redact else ''}Zenoti response to {output_path}")
        else:
            sys.stdout.write(rendered)
        return 0
    except ZenotiApiError as exc:
        status = f" (HTTP {exc.status})" if exc.status else ""
        print(f"ERROR: {exc}{status}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
