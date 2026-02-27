import json
import sys

try:
    import pymorphy3
except ImportError:
    sys.stderr.write(
        "pymorphy3 не установлен. Установите: python3 -m pip install --user pymorphy3\n"
    )
    sys.exit(1)


def main() -> int:
    raw = sys.stdin.read().strip()
    if not raw:
        sys.stdout.write("{}")
        return 0

    tokens = json.loads(raw)
    morph = pymorphy3.MorphAnalyzer()

    result = {}
    for token in tokens:
        parses = morph.parse(token)
        if not parses:
            result[token] = token
            continue
        result[token] = parses[0].normal_form

    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
