import os
import sys
import unittest

print("baseline stdout " + "x" * 25000, flush=True)
print("exact Python check stderr", file=sys.stderr, flush=True)
assert sys.prefix != sys.base_prefix
assert os.path.realpath(sys.prefix) == os.path.realpath(".venv")
assert os.path.realpath(sys.executable).startswith("/usr/") or sys.base_prefix != sys.prefix

class ExistingTests(unittest.TestCase):
    def test_existing_failure(self):
        self.assertEqual(1, 2, "existing application bug")

unittest.main()
