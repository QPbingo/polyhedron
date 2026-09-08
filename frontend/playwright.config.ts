import {defineConfig} from '@playwright/test';
export default defineConfig({testDir:'./test',testMatch:'**/*.spec.ts',fullyParallel:false,use:{baseURL:'http://127.0.0.1:15173',viewport:{width:1280,height:800},headless:true,channel:'chrome'},webServer:{command:'npm run dev -- --port 15173',url:'http://127.0.0.1:15173',reuseExistingServer:false},reporter:'list'});
