#!/bin/bash

# AudioBookVisualizer Cleanup Script
# This script removes old Docker-related FLUX service files

echo "AudioBookVisualizer Cleanup Script"
echo "================================="
echo ""
echo "This will remove old Docker-based FLUX service files."
echo "The new implementation uses local ComfyUI instead."
echo ""
read -p "Continue with cleanup? (y/N) " -n 1 -r
echo ""

if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Cleanup cancelled."
    exit 0
fi

echo "Starting cleanup..."
echo ""

# Create backup directory
BACKUP_DIR="old-flux-docker-backup-$(date +%Y%m%d-%H%M%S)"
echo "Creating backup directory: $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"

# Backup Docker-related files
echo "Backing up Docker-related files..."
if [ -d "flux-service" ]; then
    cp -r flux-service "$BACKUP_DIR/"
    echo "  ✓ Backed up flux-service directory"
fi

if [ -f "flux-manager.js" ]; then
    cp flux-manager.js "$BACKUP_DIR/"
    echo "  ✓ Backed up flux-manager.js"
fi

# Backup any workflow JSON files (if they exist)
for file in *workflow*.json *flux*.json; do
    if [ -f "$file" ]; then
        cp "$file" "$BACKUP_DIR/"
        echo "  ✓ Backed up $file"
    fi
done

echo ""
echo "Removing old files..."

# Remove Docker-related flux service directory
if [ -d "flux-service" ]; then
    rm -rf flux-service
    echo "  ✓ Removed flux-service directory"
fi

# Remove old flux-manager.js (Docker-based)
if [ -f "flux-manager.js" ]; then
    rm -f flux-manager.js
    echo "  ✓ Removed flux-manager.js"
fi

# Remove workflow JSON files
for file in *workflow*.json *flux*.json; do
    if [ -f "$file" ]; then
        rm -f "$file"
        echo "  ✓ Removed $file"
    fi
done

# Remove test and backup files
if [ -f "terminal.js.backup" ]; then
    rm -f terminal.js.backup
    echo "  ✓ Removed terminal.js.backup"
fi

if [ -f "test-terminal.js" ]; then
    rm -f test-terminal.js
    echo "  ✓ Removed test-terminal.js"
fi

echo ""
echo "Cleanup complete!"
echo ""
echo "Summary:"
echo "- Old Docker-based FLUX files have been backed up to: $BACKUP_DIR"
echo "- The application now uses local ComfyUI for FLUX image generation"
echo "- Configure ComfyUI path in Settings > ComfyUI Settings"
echo ""
echo "The backup directory can be safely deleted once you verify everything works."