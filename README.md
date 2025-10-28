# Frontend

React application for OpenAnonymity with privacy-focused LLM interactions.

## Features

- **Multi-Provider Chat**: OpenAI, Anthropic, DeepSeek, XAI, Together AI, Google AI
- **Privacy Controls**: PII removal, query obfuscation, decoy generation
- **Session Management**: Stateless (max privacy) or stateful (conversations)  
- **Modern UI**: Terminal-style interface with dark/light themes
- **Real-Time Streaming**: Live response streaming from LLMs

## Quick Start

### Prerequisites
- Node.js 16+
- Backend services running at `http://localhost:8000`

### Install and Run
```bash
cd client
npm install
npm start
```

Application opens at `http://localhost:3000`

### Backend Configuration
Update `setupProxy.js` if backend runs elsewhere:
```javascript
module.exports = function(app) {
  app.use('/api', createProxyMiddleware({
    target: 'http://your-backend-server:8000',
    changeOrigin: true
  }));
};
```

### Environment Variables
```bash
# Optional customization
REACT_APP_API_URL=http://localhost:8000
REACT_APP_WS_URL=ws://localhost:8000

# Organization API for station discovery and ticket issuance
REACT_APP_ORG_URL=https://org.openanonymity.ai

# Fallback station URL (used if org discovery fails)
REACT_APP_STATION_URL=http://localhost:8002

# Privacy Pass Provider: 'wasm' (default) or 'extension'
REACT_APP_PRIVACY_PASS_PROVIDER=wasm
```

## Privacy Pass Integration

The webapp uses Privacy Pass for anonymous authentication with inference tickets.

### Direct WASM (Default)
By default, the webapp loads the Privacy Pass WASM module directly without requiring a browser extension:

- WASM files located in `src/wasm/`
- Automatically bundled by webpack
- Initialized on first use
- No extension installation needed

### Browser Extension (Alternative)
To use the browser extension instead:

1. Set environment variable:
   ```bash
   REACT_APP_PRIVACY_PASS_PROVIDER=extension
   ```

2. Install the Privacy Pass extension from `../privacypass-extension`

### Switching Providers
The Privacy Pass service is modular and can be easily switched:

```javascript
// In src/shared/services/station.js
const PRIVACY_PASS_PROVIDER = process.env.REACT_APP_PRIVACY_PASS_PROVIDER || 'wasm';
```

Both providers implement the same interface:
- `initialize()` - Initialize the provider
- `createSingleTokenRequest(publicKey, challenge)` - Create blinded token
- `finalizeToken(signedResponse, state)` - Unblind token

## Development

### Build for Production
```bash
npm run build
```

### Run Tests
```bash
npm test
```

### Project Structure
```
src/
├── features/              # Feature modules
│   ├── chat/             # Chat functionality
│   ├── models/           # Model management  
│   └── theme/            # Theme management
├── shared/               # Shared components
│   ├── components/       # Reusable UI components
│   ├── hooks/           # Custom React hooks
│   ├── services/        # API service layer
│   └── utils/           # Utility functions
└── pages/               # Page components
```

## Troubleshooting

```bash
# Clear cache and reinstall
rm -rf node_modules package-lock.json
npm install

# Check backend connection
curl http://localhost:8000/api/health

# Check API proxy
curl http://localhost:3000/api/health

# Build issues
npm run build
```
