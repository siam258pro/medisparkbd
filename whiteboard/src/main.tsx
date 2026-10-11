import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Whiteboard from './Whiteboard.tsx';
import './index.css';
import '@fontsource/caveat/400.css';
import '@fontsource/atma/bengali-400.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Whiteboard />
  </StrictMode>,
);
