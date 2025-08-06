import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from './features/theme/ThemeProvider';
import Chat from './pages/Chat';

function App() {
  return (
    <ThemeProvider>
      <Router>
        <Routes>
          <Route path="/" element={<Chat />} />
        </Routes>
      </Router>
    </ThemeProvider>
  );
}

export default App;
