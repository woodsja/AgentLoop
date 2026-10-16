"""Create tiny deterministic wheels to exercise pip without an external source."""
import base64
import csv
import hashlib
import io
import pathlib
import sys
import zipfile

root = pathlib.Path(sys.argv[1])
for name in ('pytest', 'ruff'):
    info = f'{name}-1.0.dist-info'
    files = {
        f'{name}/__init__.py': 'def main():\n    print("fixture readiness")\n',
        f'{name}/__main__.py': 'from . import main\nmain()\n',
        f'{info}/METADATA': f'Metadata-Version: 2.1\nName: {name}\nVersion: 1.0\n',
        f'{info}/WHEEL': 'Wheel-Version: 1.0\nGenerator: fixture\nRoot-Is-Purelib: true\nTag: py3-none-any\n',
        f'{info}/entry_points.txt': f'[console_scripts]\n{name} = {name}:main\n' + ('project-check = pytest:main\n' if name == 'pytest' else ''),
    }
    records = io.StringIO()
    writer = csv.writer(records)
    for filename, content in files.items():
        digest = base64.urlsafe_b64encode(hashlib.sha256(content.encode()).digest()).rstrip(b'=').decode()
        writer.writerow((filename, f'sha256={digest}', len(content.encode())))
    writer.writerow((f'{info}/RECORD', '', ''))
    files[f'{info}/RECORD'] = records.getvalue()
    with zipfile.ZipFile(root / f'{name}-1.0-py3-none-any.whl', 'w') as archive:
        for filename, content in files.items():
            entry = zipfile.ZipInfo(filename, date_time=(2020, 1, 1, 0, 0, 0))
            archive.writestr(entry, content)
