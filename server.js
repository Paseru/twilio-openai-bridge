require('dotenv').config();
const express = require('express');
const WebSocket = require('ws');
const app = express();

// Connexion OpenAI
function connectToOpenAI() {
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('Connected to OpenAI');
  });

  openaiWs.on('error', (error) => {
    console.error('OpenAI error:', error);
  });

  return openaiWs;
}

// WebSocket server pour Twilio
const wss = new WebSocket.Server({ port: 8080 });

app.use(express.urlencoded({ extended: true }));

app.post('/voice', (req, res) => {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="ws://localhost:8080/media-stream" />
  </Connect>
</Response>`;
  res.type('text/xml').send(twiml);
});

wss.on('connection', (ws) => {
  console.log('Twilio connected');
  const openaiWs = connectToOpenAI();
  
  ws.on('message', (message) => {
    const data = JSON.parse(message);
    
    if (data.event === 'media') {
      // Audio de Twilio vers OpenAI
      openaiWs.send(JSON.stringify({
        type: 'input_audio_buffer.append',
        audio: data.media.payload
      }));
    }
  });

  // Réponses OpenAI vers Twilio
  openaiWs.on('message', (data) => {
    const response = JSON.parse(data);
    
    if (response.type === 'response.audio.delta') {
      ws.send(JSON.stringify({
        event: 'media',
        media: {
          payload: response.delta
        }
      }));
    }
  });

  ws.on('close', () => {
    console.log('Twilio disconnected');
    openaiWs.close();
  });
});

app.listen(3000, () => {
  console.log('Server started on port 3000');
  console.log('WebSocket on port 8080');
});