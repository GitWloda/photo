#!/usr/bin/env python3
import os

ROOT_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
ENV_FILE = os.path.join(ROOT_DIR, "config", "app.env")


def load_env(path: str = ENV_FILE) -> dict:
    cfg = {}
    if not os.path.isfile(path):
        return cfg

    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            cfg[key.strip()] = value.strip().strip('"').strip("'")
    return cfg


def load_env_into_os(path: str = ENV_FILE, override: bool = False) -> dict:
    cfg = load_env(path)
    for k, v in cfg.items():
        if override or k not in os.environ:
            os.environ[k] = v
    return cfg