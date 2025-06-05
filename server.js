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

// Configuration ElevenLabs
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';

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
      Phone: reservationData.contact_info.phone || '',
      Status: 'Confirmed'
    });
    
    console.log('Réservation ajoutée au Google Sheet');
    return { success: true, message: 'Reservation added successfully' };
  } catch (error) {
    console.error('Erreur Google Sheets:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour rechercher une réservation
async function findReservation(searchCriteria) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    let foundReservations = [];
    
    // Recherche par numéro de téléphone d'abord
    if (searchCriteria.phone) {
      foundReservations = rows.filter(row => 
        row.get('Phone') === searchCriteria.phone && 
        row.get('Status') !== 'Cancelled'
      );
    }
    
    // Si aucune réservation trouvée avec le téléphone, chercher par nom
    if (foundReservations.length === 0 && searchCriteria.name) {
      foundReservations = rows.filter(row => 
        row.get('Name')?.toLowerCase() === searchCriteria.name.toLowerCase() && 
        row.get('Status') !== 'Cancelled'
      );
    }
    
    if (foundReservations.length === 0) {
      return { 
        success: false, 
        message: 'No reservation found',
        found: 0 
      };
    }
    
    // Retourner les détails des réservations trouvées
    const reservations = foundReservations.map(row => ({
      rowNumber: row.rowNumber,
      date: row.get('Date'),
      guests: row.get('Guests'),
      name: row.get('Name'),
      phone: row.get('Phone'),
      status: row.get('Status')
    }));
    
    return { 
      success: true, 
      reservations: reservations,
      found: reservations.length
    };
  } catch (error) {
    console.error('Erreur recherche réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour modifier une réservation
async function modifyReservation(modificationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Trouver la ligne à modifier
    const rowToUpdate = rows.find(row => row.rowNumber === modificationData.rowNumber);
    
    if (!rowToUpdate) {
      return { success: false, error: 'Reservation not found' };
    }
    
    // Appliquer les modifications
    if (modificationData.new_date) {
      rowToUpdate.set('Date', modificationData.new_date);
    }
    if (modificationData.new_guests_count) {
      rowToUpdate.set('Guests', modificationData.new_guests_count);
    }
    if (modificationData.new_time) {
      // Si le temps est séparé de la date
      const currentDate = rowToUpdate.get('Date').split('T')[0];
      rowToUpdate.set('Date', `${currentDate}T${modificationData.new_time}`);
    }
    
    await rowToUpdate.save();
    
    console.log('Réservation modifiée');
    return { 
      success: true, 
      message: 'Reservation modified successfully',
      updatedReservation: {
        date: rowToUpdate.get('Date'),
        guests: rowToUpdate.get('Guests'),
        name: rowToUpdate.get('Name')
      }
    };
  } catch (error) {
    console.error('Erreur modification réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour annuler une réservation
async function cancelReservation(cancellationData) {
  try {
    const doc = new GoogleSpreadsheet(GOOGLE_SHEET_ID, serviceAccountAuth);
    await doc.loadInfo();
    const sheet = doc.sheetsByIndex[0];
    const rows = await sheet.getRows();
    
    // Trouver la ligne à annuler
    const rowToCancel = rows.find(row => row.rowNumber === cancellationData.rowNumber);
    
    if (!rowToCancel) {
      return { success: false, error: 'Reservation not found' };
    }
    
    // Marquer comme annulée plutôt que de supprimer
    rowToCancel.set('Status', 'Cancelled');
    await rowToCancel.save();
    
    console.log('Réservation annulée');
    return { 
      success: true, 
      message: 'Reservation cancelled successfully',
      cancelledReservation: {
        date: rowToCancel.get('Date'),
        name: rowToCancel.get('Name')
      }
    };
  } catch (error) {
    console.error('Erreur annulation réservation:', error);
    return { success: false, error: error.message };
  }
}

// Fonction pour terminer l'appel
async function endCall(ws) {
  try {
    console.log('Fin de l\'appel demandée par l\'assistant');
    
    // Envoyer le signal de raccrochage à Twilio
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        event: 'hangup',
        streamSid: ws.streamSid
      }));
    }
    
    return { success: true, message: 'Call ended successfully' };
  } catch (error) {
    console.error('Erreur lors du raccrochage:', error);
    return { success: false, error: error.message };
  }
}

app.get('/', (req, res) => {
  res.send('Server running');
});

app.post('/voice', (req, res) => {
  console.log('Appel reçu de:', req.body.From);
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

wss.on('connection', (ws, req) => {
  console.log('WebSocket Twilio connecté');
  
  // Extraire le numéro de téléphone de la requête
  const urlParams = new URLSearchParams(req.url.split('?')[1]);
  const callerPhone = urlParams.get('from') || '';
  console.log('Numéro appelant:', callerPhone);
  
  let elevenLabsWs = null;
  let audioQueue = [];
  let isPlaying = false;
  
  // Fonction pour créer une connexion ElevenLabs WebSocket
  function connectElevenLabs() {
    elevenLabsWs = new WebSocket('wss://api.elevenlabs.io/v1/text-to-speech/' + ELEVENLABS_VOICE_ID + '/stream-input?model_id=eleven_flash_v2&output_format=ulaw_8000', {
      headers: {
        'xi-api-key': ELEVENLABS_API_KEY
      }
    });
    
    elevenLabsWs.on('open', () => {
      console.log('ElevenLabs WebSocket connecté');
      
      // Configuration initiale
      elevenLabsWs.send(JSON.stringify({
        text: " ",
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.8,
          style: 0.0,
          use_speaker_boost: true
        },
        generation_config: {
          chunk_length_schedule: [50]
        }
      }));
    });
    
    elevenLabsWs.on('message', (data) => {
      const response = JSON.parse(data);
      
      if (response.audio) {
        // Envoyer directement à Twilio (déjà en ulaw)
        ws.send(JSON.stringify({
          event: 'media',
          streamSid: ws.streamSid,
          media: {
            payload: response.audio
          }
        }));
      }
    });
    
    elevenLabsWs.on('error', (error) => {
      console.error('Erreur ElevenLabs WebSocket:', error);
    });
    
    elevenLabsWs.on('close', () => {
      console.log('ElevenLabs WebSocket fermé');
    });
  }
  
  // Connexion à OpenAI Realtime
  const openaiWs = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-4o-mini-realtime-preview', {
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'OpenAI-Beta': 'realtime=v1'
    }
  });

  openaiWs.on('open', () => {
    console.log('OpenAI Realtime connecté');
    
    // Créer la connexion ElevenLabs
    connectElevenLabs();
    
    // Configuration de la session avec contexte du numéro appelant
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['text'], // Uniquement le texte en sortie
        instructions: `You are the front desk assistant at Casa Masa restaurant. Be warm, natural, and conversational.

CONTEXT: The caller's phone number is ${callerPhone || 'unknown'}.

MAIN FLOW:
1. First, understand what the caller wants:
   - If they want to MAKE a new reservation → collect all details
   - If they want to MODIFY or CANCEL → search for their existing reservation

2. For NEW RESERVATIONS:
   Collect casually (not like a form):
   - Date and time
   - Number of guests
   - Name
   - Phone number
   Then call make_reservation

3. For MODIFICATIONS/CANCELLATIONS:
   a) First, try to find their reservation automatically using the caller's phone number by calling find_reservation
   b) If not found by phone, ask for their phone number or name to search
   c) If multiple reservations found, help them identify which one
   d) Ask what they want to change or if they want to cancel
   e) Call modify_reservation or cancel_reservation accordingly

IMPORTANT:
- Always be conversational and natural
- Confirm changes before making them
- After any successful action, summarize what was done
- End calls politely with end_call function
- If someone seems confused, gently guide them

Remember: You're a friendly restaurant host, not a robot!`,
        input_audio_format: 'g711_ulaw',
        input_audio_transcription: {
          model: 'whisper-1'
        },
        turn_detection: {
          type: 'server_vad',
          threshold: 0.5,
          prefix_padding_ms: 100,
          silence_duration_ms: 300
        },
        tools: [
          {
            type: 'function',
            name: 'make_reservation',
            description: 'Create a new restaurant reservation',
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
                    }
                  }
                }
              },
              required: ['reservation_date', 'guests_count', 'contact_info']
            }
          },
          {
            type: 'function',
            name: 'find_reservation',
            description: 'Search for existing reservations by phone number or name',
            parameters: {
              type: 'object',
              properties: {
                phone: {
                  type: 'string',
                  description: 'Phone number to search'
                },
                name: {
                  type: 'string',
                  description: 'Customer name to search'
                }
              },
              required: []
            }
          },
          {
            type: 'function',
            name: 'modify_reservation',
            description: 'Modify an existing reservation',
            parameters: {
              type: 'object',
              properties: {
                rowNumber: {
                  type: 'number',
                  description: 'Row number of the reservation to modify'
                },
                new_date: {
                  type: 'string',
                  description: 'New date and time in ISO format (optional)'
                },
                new_guests_count: {
                  type: 'number',
                  description: 'New number of guests (optional)'
                },
                new_time: {
                  type: 'string',
                  description: 'New time only in HH:MM:SS format (optional)'
                }
              },
              required: ['rowNumber']
            }
          },
          {
            type: 'function',
            name: 'cancel_reservation',
            description: 'Cancel an existing reservation',
            parameters: {
              type: 'object',
              properties: {
                rowNumber: {
                  type: 'number',
                  description: 'Row number of the reservation to cancel'
                }
              },
              required: ['rowNumber']
            }
          },
          {
            type: 'function',
            name: 'end_call',
            description: 'End the phone call politely',
            parameters: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        ]
      }
    }));
    
    // Message d'accueil avec ElevenLabs WebSocket
    setTimeout(() => {
      if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
        elevenLabsWs.send(JSON.stringify({
          text: "Hello, Casa Masa restaurant, how can I help you today?",
          flush: true
        }));
      }
    }, 1000);
  });

  let textBuffer = '';
  
  openaiWs.on('message', async (data) => {
    try {
      const response = JSON.parse(data);
      
      // Capturer le texte en streaming
      if (response.type === 'response.text.delta' && response.delta) {
        textBuffer += response.delta;
        
        // Envoyer à ElevenLabs par chunks
        const chunks = textBuffer.match(/.{1,50}[.!?,\s]|.{1,50}$/g) || [];
        
        if (chunks.length > 1) {
          const chunkToSend = chunks[0];
          textBuffer = textBuffer.substring(chunkToSend.length);
          
          if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
            elevenLabsWs.send(JSON.stringify({
              text: chunkToSend,
              flush: false
            }));
          }
        }
      }
      
      // Fin de la réponse - envoyer le reste
      if (response.type === 'response.done') {
        if (textBuffer.trim() && elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.send(JSON.stringify({
            text: textBuffer,
            flush: true
          }));
          textBuffer = '';
        }
      }
      
      // Gestion des appels de fonction
      if (response.type === 'response.function_call_arguments.done') {
        console.log('Function call:', response.name, response.arguments);
        
        let result;
        const args = JSON.parse(response.arguments);
        
        switch(response.name) {
          case 'make_reservation':
            result = await addReservation(args);
            break;
            
          case 'find_reservation':
            // Si pas de téléphone fourni, utiliser celui de l'appelant
            if (!args.phone && callerPhone) {
              args.phone = callerPhone;
            }
            result = await findReservation(args);
            break;
            
          case 'modify_reservation':
            result = await modifyReservation(args);
            break;
            
          case 'cancel_reservation':
            result = await cancelReservation(args);
            break;
            
          case 'end_call':
            result = await endCall(ws);
            
            // Fermer les connexions après le raccrochage
            setTimeout(() => {
              if (openaiWs.readyState === WebSocket.OPEN) {
                openaiWs.close();
              }
              if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
                elevenLabsWs.close();
              }
              if (ws.readyState === WebSocket.OPEN) {
                ws.close();
              }
            }, 1000);
            break;
        }
        
        if (result) {
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
        if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
          elevenLabsWs.close();
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
    if (elevenLabsWs && elevenLabsWs.readyState === WebSocket.OPEN) {
      elevenLabsWs.close();
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