import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
const target=process.env.VITE_API_TARGET||'http://127.0.0.1:3001';
export default defineConfig({plugins:[react()],server:{host:'127.0.0.1',port:18417,strictPort:true,proxy:{'/api':target,'/auth':target,'/ws':{target:target.replace(/^http/,'ws'),ws:true}}},build:{sourcemap:false,rollupOptions:{output:{manualChunks:{terminal:['@xterm/xterm','@xterm/addon-fit','@xterm/addon-search','@xterm/addon-webgl'],react:['react','react-dom']}}}}});
