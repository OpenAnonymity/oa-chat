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
```

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
