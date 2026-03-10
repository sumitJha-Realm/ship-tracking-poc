#!/bin/bash
set -e

echo "============================="
echo " Ship Tracking POC - Setup"
echo "============================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
  echo "ERROR: Node.js is not installed. Install Node.js 16+ first."
  exit 1
fi

NODE_VERSION=$(node --version)
echo "Node.js version: $NODE_VERSION"

# Check .env
if [ ! -f .env ]; then
  echo "Creating .env from .env.example..."
  cp .env.example .env
  echo "IMPORTANT: Edit .env with your MongoDB Atlas URI"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install

# Create indexes
echo ""
echo "Creating indexes..."
npm run create-indexes

# Seed data
echo ""
echo "Seeding 125,000 documents..."
npm run seed-data

echo ""
echo "============================="
echo " Setup Complete!"
echo "============================="
echo ""
echo "Run the project:"
echo "  npm run start-api          # Start API server"
echo "  npm run simulate-ingestion # Start ingestion simulator"
echo "  npm run monitor            # Start performance monitor"
echo "  npm run start              # Start all three"
echo ""
