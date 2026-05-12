import pefile
import os
import subprocess

dll_path = r"C:\Windows\System32\OpenCL.dll"
vendor_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
os.makedirs(vendor_dir, exist_ok=True)

pe = pefile.PE(dll_path)
exports = []
for exp in pe.DIRECTORY_ENTRY_EXPORT.symbols:
    if exp.name:
        exports.append(exp.name.decode('utf-8'))

# Create .def file
def_path = os.path.join(vendor_dir, "OpenCL.def")
with open(def_path, 'w') as f:
    f.write("LIBRARY OpenCL\n")
    f.write("EXPORTS\n")
    for name in exports:
        f.write(f"    {name}\n")

print(f"Created {def_path} with {len(exports)} exports")

# Create import library using link.exe /lib
lib_path = os.path.join(vendor_dir, "OpenCL.lib")
result = subprocess.run(
    ["link.exe", "/lib", f"/def:{def_path}", f"/out:{lib_path}", "/machine:x64"],
    capture_output=True, text=True
)
print(result.stdout)
if result.returncode != 0:
    print("STDERR:", result.stderr)
    print("Return code:", result.returncode)
else:
    print(f"Successfully created {lib_path}")
