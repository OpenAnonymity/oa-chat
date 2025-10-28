import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './features/theme/ThemeProvider';
import OAChat from './features/chat/OAChat';

function App() {
  return (
    <ThemeProvider>
      <Router basename="/chat">
        <Routes>
          <Route path="/" element={<OAChat />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
