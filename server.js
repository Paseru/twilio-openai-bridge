const express = require('express');
const WebSocket = require('ws');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Page d'accueil
app.get('/', (req, res) => {
  res.send('Server running');
});

// Webhook Twilio - appel entrant
app.post('/voice', (req, res) => {
  console.log('Appel reçu');
  res.type('text/xml');
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${req.get('host')}/media-stream" />
      </Connect>
    </Response>
  `);
});

// WebSocket pour l'audio en temps réel
const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket connecté');
  
  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'start') {
        console.log('Stream démarré');
        // Envoyer message d'accueil
        const welcomeMessage = "Bonjour ! Je suis votre assistant IA. Comment puis-je vous aider ?";
        sendAudioResponse(ws, welcomeMessage);
      }
      
      if (data.event === 'media') {
        // Audio reçu de Twilio - ici on pourrait traiter avec OpenAI
        console.log('Audio reçu');
      }
      
    } catch (error) {
      console.error('Erreur WebSocket:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket fermé');
  });
});

// Fonction pour envoyer une réponse audio
function sendAudioResponse(ws, text) {
  // Ici on convertirait le texte en audio avec TTS
  // Pour l'instant, on envoie juste le texte
  const response = {
    event: 'media',
    media: {
      payload: Buffer.from(text).toString('base64')
    }
  };
  ws.send(JSON.stringify(response));
}

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log('WebSocket on port', port);
});