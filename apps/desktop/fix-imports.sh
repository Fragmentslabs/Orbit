#!/bin/bash
# Fix shared imports in electron files - replace relative paths with @shared/ alias

cd "$(dirname "$0")"

# Fix double-quote imports in electron
find electron -name '*.ts' -exec sed -i \
  -e 's|from "\.\./\.\./\.\./shared/|from "@shared/|g' \
  -e 's|from "\.\./\.\./shared/|from "@shared/|g' \
  -e 's|from "\.\./shared/|from "@shared/|g' \
  {} +

# Fix single-quote imports in electron
find electron -name '*.ts' -exec sed -i \
  -e "s|from '\.\./\.\./\.\./shared/|from '@shared/|g" \
  -e "s|from '\.\./\.\./shared/|from '@shared/|g" \
  -e "s|from '\.\./shared/|from '@shared/|g" \
  {} +

echo "DONE: electron imports fixed"
