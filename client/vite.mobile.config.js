import { defineConfig } from 'vite';
import { existsSync } from 'node:fs';
import react from '@vitejs/plugin-react';
export default defineConfig({root:'mobile',define:{'import.meta.env.VITE_ANDROID_PUSH_CONFIGURED':JSON.stringify(String(existsSync('android/app/google-services.json')))},plugins:[react()],base:'./',build:{outDir:'../dist-mobile',emptyOutDir:true}});
