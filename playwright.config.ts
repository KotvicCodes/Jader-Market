import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir:'./tests/browser',fullyParallel:false,workers:1,retries:0,
  timeout:180000,expect:{timeout:15000},
  reporter:[['list']],outputDir:'.cache/browser-results',
  use:{actionTimeout:15000,navigationTimeout:15000,launchOptions:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,args:['--no-sandbox','--disable-dev-shm-usage','--disable-gpu']}:undefined,baseURL:process.env.ACCEPTANCE_ORIGIN,trace:'off',screenshot:'off',video:'off'},
  projects:[
    {name:'desktop',use:{browserName:'chromium',viewport:{width:1440,height:900}}},
    {name:'mobile',use:{browserName:'chromium',viewport:{width:390,height:844},isMobile:true,hasTouch:true}},
    {name:'keyboard',use:{browserName:'chromium',viewport:{width:1280,height:800}}},
  ],
});
