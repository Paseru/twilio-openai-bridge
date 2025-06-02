const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

app.get('/', (req, res) => {
  res.send('Server running');
});

app.post('/voice', (req, res) => {
  res.type('text/xml');
  res.send(`
    <Response>
      <Say>Hello, this is your AI assistant. How can I help you?</Say>
      <Record maxLength="30" action="/process-speech"/>
    </Response>
  `);
});

app.listen(port, () => {
  console.log(`Server started on port ${port}`);
});