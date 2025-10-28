import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);

// // Stagewise toolbar integration (development only)
// if (process.env.NODE_ENV === 'development') {
//   // Dynamic import to ensure it's not included in production bundle
//   import('@stagewise/toolbar-react').then(({ StagewiseToolbar }) => {
//     const stagewiseConfig = {
//       plugins: []
//     };

//     // Create a separate container for the toolbar
//     const toolbarContainer = document.createElement('div');
//     toolbarContainer.id = 'stagewise-toolbar-root';
//     document.body.appendChild(toolbarContainer);

//     // Create a separate React root for the toolbar
//     const toolbarRoot = ReactDOM.createRoot(toolbarContainer);
//     toolbarRoot.render(<StagewiseToolbar config={stagewiseConfig} />);
//   }).catch(() => {
//     // Silently handle if stagewise is not available
//     console.log('Stagewise toolbar not available');
//   });
// }
