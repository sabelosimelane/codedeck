import React from 'react';
import ReactDOM from 'react-dom/client';
import MobileApp from './MobileApp';
import { initTheme } from '../theme';
import '../styles/global.css';
initTheme();
ReactDOM.createRoot(document.getElementById('root')).render(<MobileApp/>);
