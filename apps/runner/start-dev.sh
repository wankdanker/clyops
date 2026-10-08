#!/bin/bash

# Script Runner Development Starter
# This script helps you get started with the Script Runner UI

echo "🚀 Script Runner - Development Setup"
echo "======================================"
echo ""

# Check if node_modules exists
if [ ! -d "node_modules" ]; then
    echo "📦 Installing dependencies..."
    npm install
    if [ $? -ne 0 ]; then
        echo "❌ Failed to install dependencies"
        exit 1
    fi
    echo "✅ Dependencies installed"
    echo ""
fi

# Check if Rust/Cargo is available
if ! command -v cargo &> /dev/null; then
    echo "❌ Cargo not found. Please install Rust: https://rustup.rs/"
    exit 1
fi

echo "🔧 Building Tauri backend..."
cd src-tauri
cargo build
if [ $? -ne 0 ]; then
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

npm run tauri dev
