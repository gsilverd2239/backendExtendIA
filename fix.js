const fs = require('fs');
let content = fs.readFileSync('routes/sapRoutes.ts', 'utf8');
content = content.replace(/\\\`/g, '\`');
fs.writeFileSync('routes/sapRoutes.ts', content, 'utf8');
