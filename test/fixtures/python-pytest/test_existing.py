import sys


def test_existing_bug():
    assert sys.prefix != sys.base_prefix
    assert 1 == 2, "existing pytest application bug"
