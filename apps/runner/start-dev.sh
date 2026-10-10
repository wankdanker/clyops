#!/bin/bash

# Script Runner Development Starter
# This script helps you get started with the Script Runner UI

set -euo pipefail

# Work from the runner directory, including when called from the repo root.
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

echo "🚀 Script Runner - Development Setup"
echo "======================================"
echo ""

# Refresh links from the root workspace lockfile even after a branch switch.
echo "📦 Installing dependencies..."
pnpm install --frozen-lockfile
echo "✅ Dependencies installed"
echo ""

# Check if Rust/Cargo is available
if ! command -v cargo &> /dev/null; then
    echo "❌ Cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

echo "🔧 Building Tauri backend..."
cd src-tauri
if ! cargo build; then
    echo "❌ Failed to build Tauri backend"
    exit 1
fi
cd ..

echo "✅ Tauri backend built"
echo ""
echo "🎉 Starting development server..."
echo "   Frontend: http://localhost:1420"
echo "   The app window will open automatically"
echo ""
echo "Press Ctrl+C to stop the development server"
echo ""

pnpm run tauri dev
