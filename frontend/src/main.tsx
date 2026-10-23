// Establish cascade layer order before component styles are evaluated.
import './index.css';
import { createRoot } from 'react-dom/client';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('Frontend root element is missing');

createRoot(root).render(<App />);
