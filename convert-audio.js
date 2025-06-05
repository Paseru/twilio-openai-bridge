const { exec } = require('child_process');

const inputFile = './restaurant-ambiance.mp3';  // Votre fichier téléchargé
const outputFile = './restaurant-ambiance.mp3';

const command = `ffmpeg -i ${inputFile} -ar 8000 -ac 1 -acodec pcm_mulaw -f mulaw ${outputFile}`;

exec(command, (error, stdout, stderr) => {
  if (error) {
    console.error(`Erreur: ${error}`);
    return;
  }
  console.log('Conversion terminée !');
  console.log('Fichier créé :', outputFile);
});