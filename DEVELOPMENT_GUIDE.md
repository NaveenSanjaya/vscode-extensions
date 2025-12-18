# Ballerina Copilot - Development Guide

Complete reference guide for developing and debugging the Ballerina Extension with AI Copilot.

---

## Initial Setup (One-time)

### 1. Navigate to workspace
```powershell
cd d:\vscode-extensions
```

### 2. Check prerequisites
```powershell
node --version      # Should be 22.x or later
npm --version       # Should be 10.x or later
pnpm --version      # Should be 10.10 or later
rush --version      # Should be 5.153 or later
```

### 3. Install tools globally (if needed)
```powershell
npm install -g pnpm@latest
npm install -g @microsoft/rush@latest
```

### 4. Clean install
```powershell
rush purge
rush install
```
This may take 5-10 minutes.

### 5. Build the extension
```powershell
rush build --to ballerina
```

---

## Daily Development Workflow

### Terminal 1: Start Watch Mode (Keep Running)
```powershell
cd d:\vscode-extensions
npm run watch-ballerina
```
**What this does:** Automatically rebuilds the extension when you save files.

### Terminal 2: Open VS Code for Debugging
```powershell
cd d:\vscode-extensions
code ballerina-extension.code-workspace
```

### In VS Code
1. Press **F5** to start debugging
2. A new VS Code window opens with the extension loaded
3. Create or open a `.bal` file to test
4. Make changes to code
5. Watch mode rebuilds automatically
6. Reload the extension: `Ctrl+Shift+P` → "Developer: Reload Window"

---

## Common Development Commands

### Build Commands
```powershell
# Build only Ballerina extension
rush build --to ballerina

# Build everything
rush build

# Build with watch mode
rush build --to ballerina --watch

# Force rebuild
rush build --to ballerina --force

# Build with debug output
rush build --to ballerina --debug
```

### Clean and Reinstall
```powershell
# Full clean rebuild
rush purge
rush install
rush build --to ballerina

# Update dependencies
rush update

# Check dependency consistency
rush check
```

### Extension-Specific Commands
```powershell
cd d:\vscode-extensions\workspaces\ballerina\ballerina-extension

# Compile TypeScript
npm run compile

# Test compilation
npm run test-compile

# Run tests
npm run test

# Watch for changes (auto-rebuild)
npm run watch

# View all available scripts
cat package.json | Select-String -Pattern '"scripts"' -Context 0,20
```

---

## Debugging in VS Code

### Keyboard Shortcuts
```
F5                              Start debugging
Ctrl+Shift+P                    Open command palette
"Developer: Reload Window"      Reload extension after changes
F12                             Open DevTools
Ctrl+Shift+F                    Search code
Ctrl+`                          Toggle terminal
```

### Checking Logs
1. In the debug window, go to **View → Output**
2. Select **Ballerina** from the dropdown
3. Look for error messages or initialization logs

### Enable Debug Logging
1. Press `Ctrl+,` to open Settings
2. Search for and enable:
   - `ballerina.debugLog`
   - `ballerina.traceLog`
   - `ballerina.pluginDevMode`
3. Reload the window for changes to take effect

---

## If Things Break

### Problem: Build fails
```powershell
# Full clean rebuild
rush purge
rush install
rush build --to ballerina
```

### Problem: Extension not loading
```powershell
# Rebuild from scratch
rush rebuild --to ballerina

# Then reload in VS Code
# Ctrl+Shift+P → "Developer: Reload Window"
```

### Problem: Watch mode not working
```powershell
# Kill existing watch processes
Get-Process node | Stop-Process -Force

# Restart watch mode
npm run watch-ballerina
```

### Problem: Dependencies out of sync
```powershell
rush check
rush update
rush install
rush build --to ballerina
```

---

## Important Files and Locations

### Key Source Files
- **AI Chat Machine (Memory System):**
  ```
  workspaces/ballerina/ballerina-extension/src/views/ai-panel/aiChatMachine.ts
  ```

- **Configuration:**
  ```
  workspaces/ballerina/ballerina-extension/.env
  ```

- **Package Configuration:**
  ```
  workspaces/ballerina/ballerina-extension/package.json
  ```

### Project Structure
```
d:\vscode-extensions\
├── workspaces/
│   └── ballerina/
│       ├── ballerina-extension/        # Main extension code
│       ├── ballerina-visualizer/       # Visualization UI
│       ├── ballerina-core/             # Core library
│       └── ...other subpackages
├── common/                              # Shared utilities
└── package.json                         # Root configuration
```

---

## Environment Setup

### Configuration File (.env)
Location: `workspaces/ballerina/ballerina-extension/.env`

Required variables:
```dotenv
BALLERINA_ROOT_URL=https://dev-tools.wso2.com/ballerina-copilot
BALLERINA_AUTH_ORG=ballerinacopilot
BALLERINA_AUTH_CLIENT_ID=<your-client-id>
BALLERINA_AUTH_REDIRECT_URL=<your-redirect-url>
```

Ask your supervisor/team for valid values if missing.

---

## Quick Reference - Daily Flow

### Step 1: Start Watch Mode
```powershell
cd d:\vscode-extensions
npm run watch-ballerina
```
Keep this terminal open. ✅

### Step 2: Open Development Environment
```powershell
cd d:\vscode-extensions
code ballerina-extension.code-workspace
```

### Step 3: Start Debugging
- Press **F5** in VS Code
- A new window opens with the extension loaded

### Step 4: Test and Develop
1. Create or open a `.bal` file
2. Make code changes
3. Watch mode rebuilds automatically
4. Reload extension: `Ctrl+Shift+P` → "Developer: Reload Window"
5. Test your changes

### Step 5: Repeat
- Edit code
- Save (auto-rebuild via watch mode)
- Reload extension
- Test

---

## Troubleshooting

### Extension won't start after F5
1. Check for errors in the **Output** panel (select "Ballerina")
2. Check DevTools (F12) for console errors
3. Verify `.env` file has correct values
4. Try: `Ctrl+Shift+P` → "Developer: Reload Window"

### Build fails with "Command not found"
1. Make sure you're in `d:\vscode-extensions` root directory
2. Run `rush install` first
3. Check Node.js version: `node --version` (need 22.x+)

### Changes not reflecting in the extension
1. Verify watch mode is running
2. Reload extension: `Ctrl+Shift+P` → "Developer: Reload Window"
3. Clear VS Code cache: Delete `.vscode-test` folder if it exists

### Watch mode crashes
```powershell
# Kill all node processes
Get-Process node | Stop-Process -Force

# Restart watch
npm run watch-ballerina
```

---

## Useful Resources

- **Ballerina Documentation:** https://ballerina.io/learn/
- **VS Code Extension API:** https://code.visualstudio.com/api
- **Rush Documentation:** https://rushjs.io/
- **Memory Layer Research:** See `MEMORY_LAYER_RESEARCH_REPORT.md` in root

---

## Notes

- **Always keep watch mode running** during development for instant rebuilds
- **Reload the extension** after every code change to see updates
- **Check .env file** if Copilot won't connect to the backend
- **Use F12 DevTools** to debug frontend issues
- **Check the Ballerina output panel** for backend/extension logs

---

**Last Updated:** December 12, 2025
