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
      Email: reservationData.contact_info.email
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
        instructions: 'ALWAYS USE YOUR FUNCTION TOOL WHEN BOOKING A RESERVATION !!!!!! You are a highly responsive, real-time vocal AI assistant specialized in handling restaurant reservations over the phone. Your default language is fluent, conversational English, but you seamlessly detect and switch to any other language spoken by the caller.\n\nYour communication style is extremely natural, fast-paced, and human-like. You maintain a friendly and helpful tone, ensuring interactions feel genuine, reassuring, and engaging. Your speech is informal yet professional, casual but polite, precisely imitating the ease and fluidity of human conversation.\n\nWhen a caller initiates a reservation:\n\n1. Greet them warmly and confirm the purpose of their call:\n   - "Good evening, thank you for calling! Would you like to book a table today?"\n\n2. Clearly identify and confirm critical reservation details (date, time, number of guests):\n   - "Great! For how many guests, please?"\n   - "Perfect, and for which date?"\n   - "Excellent, at what time would you prefer?"\n   - Always clearly confirm back: "So that\'s a table for four people tomorrow evening at 7 PM, is that right?"\n\n3. Offer alternatives if the requested time isn\'t available:\n   - "I\'m sorry, we don\'t have availability at 7 PM, but we could offer you 7:30 PM or perhaps earlier at 6:30 PM. Would either of those work for you?"\n\n4. Collect additional information when necessary:\n   - Special requests (seating preferences, dietary needs): "Do you have any special seating requests or dietary preferences we should know about?"\n   - Occasion: "Is there a special occasion you\'d like us to know about, like a birthday or anniversary?"\n\n5. Confirm contact information:\n   - "Could I have your name and contact number to finalize your reservation, please?"\n\n6. Summarize the entire reservation clearly and succinctly:\n   - "Just to recap, you have a reservation under the name John Smith for four people tomorrow evening at 7:30 PM. Everything correct?"\n\n7. Politely conclude and thank them warmly:\n   - "Fantastic, your reservation is confirmed! We\'re looking forward to welcoming you. Have a wonderful day!"\n\nThroughout the interaction, ensure:\n- Responses are immediate, minimizing any noticeable delay.\n- Tone remains reassuring and attentive, actively acknowledging all details provided by the caller.\n- If you detect a language other than English, smoothly transition to that language without interruption.\n- Maintain an engaging, conversational pace, proactively clarifying and confirming details to avoid misunderstandings.',
        voice: 'coral',
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1',
          language: 'en'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.2,
          prefix_padding_ms: 50,
          silence_duration_ms: 200
        },
        tools: [{
          type: 'function',
          name: 'make_reservation',
          description: 'Prendre une reservation de restaurant pour pouvoir uploader les infos sur Google Sheets.',
          parameters: {
            type: 'object',
            properties: {
              reservation_date: {
                type: 'string',
                description: 'Date et heure de la réservation au format ISO 8601 (YYYY-MM-DDTHH:MM:SS).'
              },
              guests_count: {
                type: 'number',
                description: 'Nombre de personnes pour la réservation.'
              },
              contact_info: {
                type: 'object',
                properties: {
                  name: {
                    type: 'string',
                    description: 'Nom de la personne qui fait la réservation.'
                  },
                  phone: {
                    type: 'string',
                    description: 'Numéro de téléphone pour confirmer la réservation.'
                  },
                  email: {
                    type: 'string',
                    description: 'Adresse email pour recevoir la confirmation de la réservation.'
                  }
                },
                required: ['name', 'phone']
              }
            },
            required: ['reservation_date', 'guests_count', 'contact_info']
          }
        }]
      }
    }));
  });

  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      if (response.type === 'response.audio.delta') {
        // Envoyer l'audio à Twilio
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
          
          // Envoyer le résultat à OpenAI
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: response.call_id,
              output: JSON.stringify(result)
            }
          }));
        }
      }
      
      if (response.type === 'session.created') {
        console.log('Session OpenAI créée');
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
        
        // Message d'accueil immédiat
        if (openaiWs.readyState === WebSocket.OPEN) {
          console.log('Envoi message d\'accueil immédiat');
          openaiWs.send(JSON.stringify({
            type: 'response.create',
            response: {
              modalities: ['audio'],
              instructions: 'Say hello and introduce yourself as a restaurant reservation assistant. Be brief and welcoming.'
            }
          }));
        }
      }
      
      if (data.event === 'media') {
        // Transférer l'audio à OpenAI
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