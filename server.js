const express = require('express');
const WebSocket = require('ws');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Configuration Google Sheets
const GOOGLE_SHEET_ID = '1qr1nMXsG5BQvEFisli3qnKCbFiXX0xK6EWXhGZ1hbxM';
const serviceAccountAuth = new JWT({
  email: 'smart-ai-partners@test-b8502.iam.gserviceaccount.com',
  key: process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});

// Fonction pour ajouter une réservation
async function addReservation(reservationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    
    await sheet.addRow({
      Date: reservationData.reservation_date,
      Guests: reservationData.guests_count,
      Name: reservationData.contact_info.name,
      Phone: reservationData.contact_info.phone,
      Email: reservationData.contact_info.email || ''
    });
    
    console.log('Réservation ajoutée au Google Sheet');
    return { success: true };
  } catch (error) {
    console.error('Erreur Google Sheets:', error);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.send('Server running');
});

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

const server = require('http').createServer(app);
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  console.log('WebSocket Twilio connecté');
  
  // Connexion à OpenAI Realtime
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime connecté');
    
    // Configuration de la session avec function tool
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text', 'audio'],
        instructions: 'You MUST collect ALL required information BEFORE calling the function tool. Required: date, time, number of guests, name, phone. ONLY call make_reservation when you have ALL these details confirmed. Be conversational and natural but gather complete information first.',
        voice: 'coral',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.1,
          prefix_padding_ms: 100,
          silence_duration_ms: 300
        },
        tools: [{
          type: 'function',
          name: 'make_reservation',
          description: 'Book restaurant reservation with complete details',
          parameters: {
            type: 'object',
            properties: {
              reservation_date: {
                type: 'string',
                description: 'Date and time in ISO format (YYYY-MM-DDTHH:MM:SS)'
              },
              guests_count: {
                type: 'number',
                description: 'Number of guests'
              },
              contact_info: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Customer name'
                  },
                  phone: {
                    type: 'string',
                    description: 'Phone number'
                  },
                  email: {
                    type: 'string',
                    description: 'Email address'
                  }
                }
              }
            },
            required: ['reservation_date', 'guests_count', 'customer_name', 'phone_number']
          }
        }]
      }
    }));
    
    // Message d'accueil automatique
    setTimeout(() => {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'assistant',
          content: [{
            type: 'text',
            text: 'Hello! Thank you for calling. I\'d be happy to help you make a reservation today.'
          }]
        }
      }));
      
      openaiWs.send(JSON.stringify({
        type: 'response.create'
      }));
    }, 500);
  });

  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      if (response.type === 'response.audio.delta') {
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: ws.streamSid,
          media: {
            payload: response.delta
          }
        }));
      }
      
      if (response.type === 'response.function_call_arguments.done') {
        console.log('Function call:', response.name, response.arguments);
        
        if (response.name === 'make_reservation') {
          const args = JSON.parse(response.arguments);
          const result = await addReservation(args);
          
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: response.call_id,
              output: JSON.stringify(result)
            }
          }));
          
          openaiWs.send(JSON.stringify({
            type: 'response.create'
          }));
        }
      }
      
    } catch (error) {
      console.error('Erreur OpenAI message:', error);
    }
  });

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      if (data.event === 'start') {
        console.log('Stream Twilio démarré');
        ws.streamSid = data.start.streamSid;
      }
      
      if (data.event === 'media') {
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: data.media.payload
          }));
        }
      }
      
      if (data.event === 'stop') {
        console.log('Stream arrêté');
        if (openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.close();
        }
      }
      
    } catch (error) {
      console.error('Erreur Twilio message:', error);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket Twilio fermé');
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  openaiWs.on('close', () => {
    console.log('OpenAI WebSocket fermé');
  });

  openaiWs.on('error', (error) => {
    console.error('Erreur OpenAI WebSocket:', error);
  });
});

server.listen(port, () => {
  console.log(`Server started on port ${port}`);
  console.log('WebSocket on port', port);
});