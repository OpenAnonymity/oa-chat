# OA Chat

A minimal, fully-functional chat web application that replicates OpenRouter's chat interface design and core functionality.

## Features

### Core Functionality
- ✅ **Chat Sessions**: Create, switch between, and manage multiple chat sessions
- ✅ **Model Selection**: Select from multiple AI models with searchable picker (⌘K)
- ✅ **Message Display**: Clean message bubbles for user and AI responses
- ✅ **Markdown Rendering**: Full markdown support using Marked.js
- ✅ **LaTeX Rendering**: Mathematical equations with KaTeX
- ✅ **IndexedDB Storage**: Persistent sessions and messages in browser database
- ✅ **Auto-scrolling**: Messages automatically scroll to bottom
- ✅ **Keyboard Shortcuts**:
  - ⌘/ - New chat
  - ⌘K - Open model picker
  - ⌘⇧⌫ - Clear chat
  - Enter - Send message
  - Escape - Close modals

### Advanced Features
- 🔍 **Live Model Search**: Filter models by name, provider, or category
- ⚙️ **Settings Menu**:
  - Auto-expand
  - Export/Import
  - Get Markdown
  - Clear Models
  - Clear Chat
  - Share Models
- 🔄 **Search Toggle**: Enable/disable search functionality
- 📁 **File Upload**: Attach files to messages (UI ready)
- 💾 **Memory System**: Context management (UI ready)

### User Interface
- Clean three-panel layout (sidebar, chat area, input)
- OpenRouter-inspired design with Tailwind CSS
- Responsive and accessible
- Smooth animations and transitions
- Auto-resizing textarea
- Session search functionality

### Model Selection
The app includes 13 pre-configured models across 4 categories:
- **Flagship models**: GPT-4, GPT-4 Turbo, GPT-3.5 Turbo, Claude 3 (Opus, Sonnet, Haiku)
- **Best roleplay models**: Mistral Large, Mixtral 8x7B, Llama 3 70B
- **Best coding models**: DeepSeek Coder, CodeLlama 70B
- **Reasoning models**: O1 Preview, O1 Mini

## Technical Details

### Architecture
- **Single HTML File**: All code (HTML, CSS, JavaScript) in one file for simplicity
- **No Backend**: Runs entirely in the browser with simulated AI responses
- **No Build Process**: Just open index.html in a browser

### Dependencies (loaded from CDN)
- Tailwind CSS - Styling framework
- Marked.js - Markdown parsing
- KaTeX - LaTeX rendering

### Code Structure
```javascript
// State Management
- Sessions array with messages
- Selected models array
- Model definitions

// Rendering Functions
- renderSessions() - Updates sidebar
- renderMessages() - Displays chat messages
- renderSelectedModels() - Shows active models
- renderModels() - Modal model picker

// Core Functions
- createSession() - New chat
- switchSession() - Change active chat
- addMessage() - Add to conversation
- sendMessage() - Send user message
- deleteSession() - Remove chat

// Storage
- saveToLocalStorage() - Persist state
- loadFromLocalStorage() - Restore state
```

## Usage

### Running Locally
1. Open `index.html` in a web browser
2. Or serve with a local server:
   ```bash
   python3 -m http.server 8080
   # Open http://localhost:8080
   ```

### Key Features Demo
1. **Creating a New Chat**:
   - Click "New Chat" button
   - Or press ⌘/ (Cmd+/)

2. **Sending Messages**:
   - Type in the input area
   - Press Enter or click send button
   - Shift+Enter for new line

3. **Selecting Models**:
   - Click "+ Add Model" button
   - Select from available models
   - Models show as chips above chat

4. **Markdown Support**:
   ```
   **bold text**
   *italic text*
   # Heading
   - List item
   \`\`\`javascript
   code block
   \`\`\`
   ```

5. **LaTeX Support**:
   ```
   Inline: $E = mc^2$
   Display: $$\int_0^\infty e^{-x^2} dx = \frac{\sqrt{\pi}}{2}$$
   ```

## Customization

### Adding More Models
Edit the `state.models` array in the HTML file:
```javascript
state.models.push({
    id: 'model-id',
    name: 'Model Name',
    category: 'Category',
    provider: 'Provider'
});
```

### Styling
- Colors are defined in Tailwind config
- Custom styles in `<style>` tag
- Modify as needed for your theme

### AI Response Simulation
The `sendMessage()` function contains simulated responses.
Replace with actual API calls:
```javascript
// Replace this simulation
setTimeout(() => {
    const responses = [...];
    addMessage('assistant', randomResponse);
}, 1000);

// With actual API call
fetch('https://api.example.com/chat', {
    method: 'POST',
    body: JSON.stringify({ message: content })
})
.then(response => response.json())
.then(data => addMessage('assistant', data.message));
```

## Browser Support
- Modern browsers (Chrome, Firefox, Safari, Edge)
- Requires ES6+ JavaScript support
- Local storage for persistence

## Notes
- This is a frontend-only demo with simulated AI responses
- To connect to real AI models, implement API integration
- Session data persists in browser's local storage
- No server-side code required

## License
Educational/demonstration purposes

## Credits
Interface inspired by OpenRouter

