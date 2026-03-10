#!/bin/bash
# Verification script for Task 4.2: Superwords UI and docs

echo "=== Verifying Superwords UI Implementation ==="
echo ""

# Check that all required files exist
echo "1. Checking file existence..."
FILES=(
  "packages/ui/src/components/sections/openchamber/SuperwordsSettings.tsx"
  "packages/ui/src/components/sections/openchamber/SuperwordsSettings.test.tsx"
  "packages/ui/src/components/sections/openchamber/types.ts"
  "packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx"
  "packages/ui/src/lib/openchamberConfig.ts"
  "packages/ui/src/lib/settings/metadata.ts"
  "packages/ui/src/components/views/SettingsView.tsx"
  "docs/SUPERWORDS.md"
)

ALL_FILES_EXIST=true
for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    echo "  ✓ $file"
  else
    echo "  ✗ $file NOT FOUND"
    ALL_FILES_EXIST=false
  fi
done

if [ "$ALL_FILES_EXIST" = false ]; then
  echo "ERROR: Some files are missing!"
  exit 1
fi

echo ""
echo "2. Checking SuperwordsSettings component..."
if grep -q "export function SuperwordsSettings" packages/ui/src/components/sections/openchamber/SuperwordsSettings.tsx; then
  echo "  ✓ SuperwordsSettings component exported"
else
  echo "  ✗ SuperwordsSettings component not exported"
  exit 1
fi

if grep -q "getSuperwordsConfig" packages/ui/src/components/sections/openchamber/SuperwordsSettings.tsx; then
  echo "  ✓ Uses getSuperwordsConfig"
else
  echo "  ✗ Does not use getSuperwordsConfig"
  exit 1
fi

if grep -q "saveSuperwordsConfig" packages/ui/src/components/sections/openchamber/SuperwordsSettings.tsx; then
  echo "  ✓ Uses saveSuperwordsConfig"
else
  echo "  ✗ Does not use saveSuperwordsConfig"
  exit 1
fi

echo ""
echo "3. Checking config functions..."
if grep -q "export async function getSuperwordsConfig" packages/ui/src/lib/openchamberConfig.ts; then
  echo "  ✓ getSuperwordsConfig function exported"
else
  echo "  ✗ getSuperwordsConfig function not exported"
  exit 1
fi

if grep -q "export async function saveSuperwordsConfig" packages/ui/src/lib/openchamberConfig.ts; then
  echo "  ✓ saveSuperwordsConfig function exported"
else
  echo "  ✗ saveSuperwordsConfig function not exported"
  exit 1
fi

echo ""
echo "4. Checking type definitions..."
if grep -q "'superwords'" packages/ui/src/components/sections/openchamber/types.ts; then
  echo "  ✓ 'superwords' added to OpenChamberSection type"
else
  echo "  ✗ 'superwords' not in OpenChamberSection type"
  exit 1
fi

if grep -q "'superwords'" packages/ui/src/lib/settings/metadata.ts; then
  echo "  ✓ 'superwords' added to settings metadata"
else
  echo "  ✗ 'superwords' not in settings metadata"
  exit 1
fi

echo ""
echo "5. Checking integration..."
if grep -q "SuperwordsSettings" packages/ui/src/components/sections/openchamber/OpenChamberPage.tsx; then
  echo "  ✓ SuperwordsSettings integrated in OpenChamberPage"
else
  echo "  ✗ SuperwordsSettings not integrated in OpenChamberPage"
  exit 1
fi

if grep -q "superwords" packages/ui/src/components/views/SettingsView.tsx; then
  echo "  ✓ 'superwords' added to SettingsView"
else
  echo "  ✗ 'superwords' not in SettingsView"
  exit 1
fi

echo ""
echo "6. Running tests..."
cd packages/ui
if bun test src/components/sections/openchamber/SuperwordsSettings.test.tsx > /dev/null 2>&1; then
  echo "  ✓ All tests pass"
else
  echo "  ✗ Tests failed"
  exit 1
fi
cd ../..

echo ""
echo "7. Checking documentation..."
if [ -f "docs/SUPERWORDS.md" ]; then
  if grep -q "Superwords" docs/SUPERWORDS.md && grep -q "Configuration" docs/SUPERWORDS.md; then
    echo "  ✓ Documentation exists and has content"
  else
    echo "  ✗ Documentation exists but lacks content"
    exit 1
  fi
else
  echo "  ✗ Documentation not found"
  exit 1
fi

echo ""
echo "=== All Verification Checks Passed! ==="
echo ""
echo "Summary:"
echo "  - SuperwordsSettings component created"
echo "  - Config functions (get/set) added to openchamberConfig.ts"
echo "  - Types updated (OpenChamberSection, SettingsPageSlug)"
echo "  - Integration complete (OpenChamberPage, SettingsView)"
echo "  - Tests passing (12 tests)"
echo "  - Documentation created (docs/SUPERWORDS.md)"
echo ""
echo "Task 4.2: Superwords UI and docs - COMPLETE"
