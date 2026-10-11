import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Whiteboard from './Whiteboard.tsx';
import './index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Whiteboard />
  </StrictMode>,
);
