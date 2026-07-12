import os
from functools import lru_cache


def _required_env(name):
    value = os.environ.get(name)
    if not value or value.startswith("your_"):
        raise RuntimeError(f"{name} is not configured")
    return value


def _create_client(url, key):
    try:
        from supabase import create_client
    except ImportError as exc:
        raise RuntimeError(
            "Supabase Python client is not installed. Run `pip install -r requirements.txt`."
        ) from exc

    return create_client(url, key)


@lru_cache(maxsize=1)
def get_supabase():
    return _create_client(
        _required_env("SUPABASE_URL"),
        _required_env("SUPABASE_ANON_KEY"),
    )


@lru_cache(maxsize=1)
def get_supabase_admin():
    return _create_client(
        _required_env("SUPABASE_URL"),
        _required_env("SUPABASE_SERVICE_KEY"),
    )
