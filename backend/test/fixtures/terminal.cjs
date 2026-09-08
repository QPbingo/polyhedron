// Integration-only PTY process. Never invokes an Agent, shell command or network API.
process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');
process.stdout.write('\x1b[32mPTY READY\x1b[0m\r\n› ');
let line='';
process.stdin.on('data',data=>{for(const c of data){if(c==='\r'||c==='\n'){process.stdout.write('\r\nACK:'+line+'\r\n› ');line='';}else if(c==='\x03'||c==='\x1b'){line='';process.stdout.write('\r\n[interrupted]\r\n› ');}else if(c==='\x7f'){line=line.slice(0,-1);}else{line+=c;process.stdout.write(c);}}});
