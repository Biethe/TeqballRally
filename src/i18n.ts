/**
 * Interface language.
 *
 * Every string a player reads outside the 3D scene comes from here. The
 * English catalogue is the source of truth: its keys are the type, so a
 * translation that misses one, or invents one, fails the build rather than
 * showing a blank button to whoever chose that language.
 *
 * Four languages, chosen because they are the ones on the court — the roster
 * is Brazil, England, France and Spain.
 */
export type Language = "en" | "fr" | "es" | "pt";

export const LANGUAGES: { id: Language; label: string }[] = [
  { id: "en", label: "English" },
  { id: "fr", label: "Français" },
  { id: "es", label: "Español" },
  { id: "pt", label: "Português" },
];

const EN = {
  // — title —
  "title.kicker": "TABLE FOOTBALL",
  "title.tagline": "Fast rallies on the curved table.",
  "title.play": "PLAY",
  "title.settings": "SETTINGS",

  // — navigation —
  "nav.back": "BACK",
  "nav.done": "DONE",

  // — play —
  "play.title": "HOW DO YOU WANT TO PLAY?",
  "play.practice": "PRACTICE",
  "play.practice.sub": "Learn one skill at a time",
  "play.friendly": "FRIENDLY",
  "play.friendly.sub": "A quick match against the CPU",
  "play.competition": "COMPETITION",
  "play.competition.sub": "Build your run",
  "play.online": "ONLINE",
  "play.online.sub": "Play someone else, wherever they are",

  // — difficulty —
  "difficulty.title": "DIFFICULTY",
  "difficulty.sub": "How hard should the CPU make you work?",
  "difficulty.easy": "EASY",
  "difficulty.easy.sub": "Room to learn the rally",
  "difficulty.normal": "NORMAL",
  "difficulty.normal.sub": "A fair game",
  "difficulty.hard": "HARD",
  "difficulty.hard.sub": "Punishes a loose ball",

  // — competition —
  "comp.title": "COMPETITION",
  "comp.sub": "Build your run.",
  "comp.cup": "CUP",
  "comp.cup.sub": "A knockout run to the final",
  "comp.league": "LEAGUE",
  "comp.league.sub": "Three rounds. Every result counts.",

  // — online —
  "online.title": "PLAY ONLINE",
  "online.sub": "Play someone else, wherever they are.",
  "online.quick": "QUICK MATCH",
  "online.quick.sub": "Get paired with another player",
  "online.friend": "PLAY A FRIEND",
  "online.friend.sub": "Create a game and share the code",
  "online.code": "ENTER A CODE",
  "online.code.sub": "Join a friend's game",
  "online.unavailable": "Online play is unavailable in this build.",

  // — settings —
  "settings.title": "SETTINGS",
  "settings.display": "DISPLAY",
  "settings.display.sub": "Graphics, camera and language",
  "settings.gameplay": "GAMEPLAY",
  "settings.gameplay.sub": "How much the game helps you",
  "settings.audio": "AUDIO",
  "settings.audio.sub": "Music and sound effects",
  "settings.graphics": "Graphics",
  "settings.graphics.hint": "Detail against framerate",
  "settings.graphics.warning": "Changing this restarts the game.",
  "settings.camera": "Camera",
  "settings.camera.hint": "The view a match opens in",
  "settings.camera.court": "Court",
  "settings.camera.side": "Side",
  "settings.camera.top": "Top",
  "settings.language": "Language",
  "settings.language.hint": "Menus and on-screen text",
  "settings.autoReception": "Automatic reception",
  "settings.autoReception.hint": "Standing near the ball takes the first touch for you",
  "settings.music": "Music",
  "settings.music.hint": "Menu and match loops",
  "settings.sound": "Sound effects",
  "settings.sound.hint": "Kicks, bounces and the crowd",
  "settings.restart.title": "RESTART",
  "settings.restart.body":
    "Changing the graphics rebuilds the scene, so the game starts over from the title screen.",
  "settings.restart.confirm": "RESTART NOW",
  "settings.restart.cancel": "CANCEL",

  // — the picker —
  "select.title": "CHOOSE YOUR SETUP",
  "select.player": "PLAYER",
  "select.ball": "BALL",
  "select.play": "PLAY",
  "select.loading": "Loading…",
  "select.abilities.reactivity": "REACTIVITY",
  "select.abilities.power": "POWER",
  "select.abilities.control": "CONTROL",
  "select.strongFoot": "STRONG FOOT",
  "select.height": "HEIGHT",
  "select.twoFooted": "TWO-FOOTED",
  "select.left": "LEFT",
  "select.right": "RIGHT",

  // — in play —
  "hud.you": "YOU",
  "hud.cpu": "CPU",
  "pause.title": "PAUSED",
  "pause.resume": "RESUME",
  "pause.quit": "QUIT TO MENU",
  "end.rematch": "REMATCH",
  "end.change": "CHANGE SETUP",

  // — career —
  "career.coins": "COINS",
  "career.trophies": "TROPHIES",
  "career.champions": "CHAMPIONS",
  "career.champions.sub": "Your roster, and what it takes to grow it",
  "career.challenges": "CHALLENGES",
  "career.challenges.sub": "Three a day. They reset at midnight.",
  "career.level": "LEVEL",
  "career.locked": "LOCKED",
  "career.unlockAt": "Unlocks at {n} trophies",
  "career.upgrade": "UPGRADE",
  "career.maxLevel": "FULLY TRAINED",
  "career.cannotAfford": "Not enough coins",
  "career.nextLevel": "{n} more matches to the next level",
  "career.precision": "PRECISION",
  "career.power": "TOTAL POWER",
  "career.selected": "SELECTED",
  "career.resetsIn": "Resets in {t}",
  "career.claim": "COLLECT",
  "career.claimed": "COLLECTED",
  "career.rank": "RANK",
  "career.promoted": "PROMOTED",
  "career.relegated": "RELEGATED",
  "career.nextRank": "{n} to {tier}",
  "career.topRank": "Top of the ladder",
  "career.reward": "REWARD",
  "career.empty": "Play a match to start your career.",

  // — account —
  "profile.title": "YOUR PROFILE",
  "profile.signedOut": "PLAY UNDER YOUR OWN NAME",
  "profile.why": "A name on the leaderboard, trophies that follow you to your next phone, and an opponent who knows who they just played.",
  "profile.name": "Your name",
  "profile.create": "CREATE PROFILE",
  "profile.creating": "Creating…",
  "profile.warning": "The profile lives on this device. There is no password to recover it, so keep your code somewhere safe.",
  "profile.fresh": "A new profile starts from zero. The {n} trophies you have played for stay on this device, but they will not be on the leaderboard.",
  "profile.code": "YOUR CODE",
  "profile.codeHint": "Share it so other players can find you.",
  "profile.rename": "CHANGE NAME",
  "profile.matches": "MATCHES",
  "profile.rank": "WORLD RANK",
  "profile.leaderboard": "LEADERBOARD",
  "profile.offline": "Cannot reach the server right now. The game plays on without it.",
  "profile.unranked": "Unranked",
  "name.short": "A little longer, please.",
  "name.long": "That is too long for a card.",
  "name.characters": "Letters, digits, spaces, - and _ only.",
  "board.title": "LEADERBOARD",
  "board.sub": "{n} players",
  "board.you": "YOU",
  "board.empty": "Nobody has played yet. Be first.",

  "challenge.matches": "Play {n} matches",
  "challenge.wins": "Win {n} matches",
  "challenge.points": "Score {n} points",
  "challenge.rallies": "Play {n} long rallies",
  "challenge.sets": "Win {n} sets",
  "challenge.matches.one": "Play one match",
  "challenge.wins.one": "Win a match",
  "challenge.points.one": "Score a point",
  "challenge.rallies.one": "Play a long rally",
  "challenge.sets.one": "Win a set",

  // — results —
  "result.win": "MATCH WON",
  "result.loss": "MATCH LOST",
  "result.trophies": "TROPHIES",
  "result.coins": "COINS",
  "result.levelUp": "LEVEL UP",
  "result.challengeDone": "CHALLENGE COMPLETE",
  "result.continue": "CONTINUE",

  // — loading tips —
  "tip.power": "A slow swipe lifts the ball. A fast one drills it.",
  "tip.setup": "Tap where you want the ball, not where you want to stand.",
  "tip.deep": "Play the set-up deep and the finish opens up.",
  "tip.reception": "Stand near the ball and the first touch takes itself.",
  "tip.miss": "Hit it flat out and it will sometimes go long. That is the trade.",
  "tip.serve": "Serve wide to pull them off the table.",

  "loading.court": "Building the court…",
  "loading.match": "Setting up the match…",
} as const;

export type StringKey = keyof typeof EN;
type Catalogue = Record<StringKey, string>;

const FR: Catalogue = {
  "title.kicker": "FOOTBALL DE TABLE",
  "title.tagline": "Des échanges rapides sur la table courbée.",
  "title.play": "JOUER",
  "title.settings": "RÉGLAGES",

  "nav.back": "RETOUR",
  "nav.done": "TERMINÉ",

  "play.title": "COMMENT VOULEZ-VOUS JOUER ?",
  "play.practice": "ENTRAÎNEMENT",
  "play.practice.sub": "Apprendre un geste à la fois",
  "play.friendly": "AMICAL",
  "play.friendly.sub": "Un match rapide contre l'ordinateur",
  "play.competition": "COMPÉTITION",
  "play.competition.sub": "Construisez votre parcours",
  "play.online": "EN LIGNE",
  "play.online.sub": "Affrontez quelqu'un, où qu'il soit",

  "difficulty.title": "DIFFICULTÉ",
  "difficulty.sub": "Jusqu'où l'ordinateur doit-il vous pousser ?",
  "difficulty.easy": "FACILE",
  "difficulty.easy.sub": "De quoi apprendre l'échange",
  "difficulty.normal": "NORMAL",
  "difficulty.normal.sub": "Un match équilibré",
  "difficulty.hard": "DIFFICILE",
  "difficulty.hard.sub": "Ne pardonne pas un ballon mal placé",

  "comp.title": "COMPÉTITION",
  "comp.sub": "Construisez votre parcours.",
  "comp.cup": "COUPE",
  "comp.cup.sub": "Une série à élimination directe jusqu'à la finale",
  "comp.league": "CHAMPIONNAT",
  "comp.league.sub": "Trois journées. Chaque résultat compte.",

  "online.title": "JOUER EN LIGNE",
  "online.sub": "Affrontez quelqu'un, où qu'il soit.",
  "online.quick": "MATCH RAPIDE",
  "online.quick.sub": "Trouvez un adversaire automatiquement",
  "online.friend": "INVITER UN AMI",
  "online.friend.sub": "Créez une partie et partagez le code",
  "online.code": "ENTRER UN CODE",
  "online.code.sub": "Rejoignez la partie d'un ami",
  "online.unavailable": "Le jeu en ligne n'est pas disponible dans cette version.",

  "settings.title": "RÉGLAGES",
  "settings.display": "AFFICHAGE",
  "settings.display.sub": "Graphismes, caméra et langue",
  "settings.gameplay": "JEU",
  "settings.gameplay.sub": "L'aide que le jeu vous apporte",
  "settings.audio": "AUDIO",
  "settings.audio.sub": "Musique et effets sonores",
  "settings.graphics": "Graphismes",
  "settings.graphics.hint": "Détail contre fluidité",
  "settings.graphics.warning": "Ce changement redémarre le jeu.",
  "settings.camera": "Caméra",
  "settings.camera.hint": "La vue au début d'un match",
  "settings.camera.court": "Terrain",
  "settings.camera.side": "Côté",
  "settings.camera.top": "Dessus",
  "settings.language": "Langue",
  "settings.language.hint": "Menus et textes à l'écran",
  "settings.autoReception": "Réception automatique",
  "settings.autoReception.hint": "Être près du ballon suffit pour la première touche",
  "settings.music": "Musique",
  "settings.music.hint": "Boucles des menus et des matchs",
  "settings.sound": "Effets sonores",
  "settings.sound.hint": "Frappes, rebonds et public",
  "settings.restart.title": "REDÉMARRER",
  "settings.restart.body":
    "Changer les graphismes reconstruit la scène : le jeu repart de l'écran d'accueil.",
  "settings.restart.confirm": "REDÉMARRER",
  "settings.restart.cancel": "ANNULER",

  "select.title": "COMPOSEZ VOTRE ÉQUIPE",
  "select.player": "JOUEUR",
  "select.ball": "BALLON",
  "select.play": "JOUER",
  "select.loading": "Chargement…",
  "select.abilities.reactivity": "RÉACTIVITÉ",
  "select.abilities.power": "PUISSANCE",
  "select.abilities.control": "CONTRÔLE",
  "select.strongFoot": "PIED FORT",
  "select.height": "TAILLE",
  "select.twoFooted": "DEUX PIEDS",
  "select.left": "GAUCHE",
  "select.right": "DROIT",

  "hud.you": "VOUS",
  "hud.cpu": "ORDI",
  "pause.title": "EN PAUSE",
  "pause.resume": "REPRENDRE",
  "pause.quit": "QUITTER",
  "end.rematch": "REVANCHE",
  "end.change": "CHANGER D'ÉQUIPE",

  // — career —
  "career.coins": "PIÈCES",
  "career.trophies": "TROPHÉES",
  "career.champions": "CHAMPIONS",
  "career.champions.sub": "Votre effectif, et comment le faire grandir",
  "career.challenges": "DÉFIS",
  "career.challenges.sub": "Trois par jour. Ils repartent à minuit.",
  "career.level": "NIVEAU",
  "career.locked": "VERROUILLÉ",
  "career.unlockAt": "Débloqué à {n} trophées",
  "career.upgrade": "AMÉLIORER",
  "career.maxLevel": "AU SOMMET",
  "career.cannotAfford": "Pas assez de pièces",
  "career.nextLevel": "Encore {n} matchs avant le niveau suivant",
  "career.precision": "PRÉCISION",
  "career.power": "PUISSANCE TOTALE",
  "career.selected": "SÉLECTIONNÉ",
  "career.resetsIn": "Réinitialisation dans {t}",
  "career.claim": "RÉCUPÉRER",
  "career.claimed": "RÉCUPÉRÉ",
  "career.rank": "RANG",
  "career.promoted": "PROMU",
  "career.relegated": "RELÉGUÉ",
  "career.nextRank": "{n} pour {tier}",
  "career.topRank": "Sommet du classement",
  "career.reward": "RÉCOMPENSE",
  "career.empty": "Jouez un match pour lancer votre carrière.",

  // — account —
  "profile.title": "VOTRE PROFIL",
  "profile.signedOut": "JOUEZ SOUS VOTRE NOM",
  "profile.why": "Un nom au classement, des trophées qui vous suivent sur votre prochain téléphone, et un adversaire qui sait qui il vient d'affronter.",
  "profile.name": "Votre nom",
  "profile.create": "CRÉER LE PROFIL",
  "profile.creating": "Création…",
  "profile.warning": "Le profil vit sur cet appareil. Aucun mot de passe ne permet de le récupérer : gardez votre code en lieu sûr.",
  "profile.fresh": "Un nouveau profil part de zéro. Vos {n} trophées restent sur cet appareil, mais ne seront pas au classement.",
  "profile.code": "VOTRE CODE",
  "profile.codeHint": "Partagez-le pour qu'on vous retrouve.",
  "profile.rename": "CHANGER DE NOM",
  "profile.matches": "MATCHS",
  "profile.rank": "CLASSEMENT MONDIAL",
  "profile.leaderboard": "CLASSEMENT",
  "profile.offline": "Serveur injoignable pour le moment. Le jeu continue sans lui.",
  "profile.unranked": "Non classé",
  "name.short": "Un peu plus long, s'il vous plaît.",
  "name.long": "Trop long pour une carte.",
  "name.characters": "Lettres, chiffres, espaces, - et _ uniquement.",
  "board.title": "CLASSEMENT",
  "board.sub": "{n} joueurs",
  "board.you": "VOUS",
  "board.empty": "Personne n'a encore joué. À vous.",

  "challenge.matches": "Jouez {n} matchs",
  "challenge.wins": "Gagnez {n} matchs",
  "challenge.points": "Marquez {n} points",
  "challenge.rallies": "Jouez {n} longs échanges",
  "challenge.sets": "Gagnez {n} sets",
  "challenge.matches.one": "Jouez un match",
  "challenge.wins.one": "Gagnez un match",
  "challenge.points.one": "Marquez un point",
  "challenge.rallies.one": "Jouez un long échange",
  "challenge.sets.one": "Gagnez un set",

  // — results —
  "result.win": "MATCH GAGNÉ",
  "result.loss": "MATCH PERDU",
  "result.trophies": "TROPHÉES",
  "result.coins": "PIÈCES",
  "result.levelUp": "NIVEAU SUPÉRIEUR",
  "result.challengeDone": "DÉFI RELEVÉ",
  "result.continue": "CONTINUER",

  // — loading tips —
  "tip.power": "Un swipe lent lève la balle. Un swipe rapide la tend.",
  "tip.setup": "Touchez où vous voulez la balle, pas où vous voulez être.",
  "tip.deep": "Une remise profonde ouvre la finition.",
  "tip.reception": "Restez près de la balle : la première touche se fait seule.",
  "tip.miss": "Frappée à fond, elle sortira parfois. C'est le prix de la vitesse.",
  "tip.serve": "Servez large pour l'écarter de la table.",

  "loading.court": "Préparation du terrain…",
  "loading.match": "Préparation du match…",
};

const ES: Catalogue = {
  "title.kicker": "FÚTBOL DE MESA",
  "title.tagline": "Peloteos rápidos sobre la mesa curva.",
  "title.play": "JUGAR",
  "title.settings": "AJUSTES",

  "nav.back": "ATRÁS",
  "nav.done": "LISTO",

  "play.title": "¿CÓMO QUIERES JUGAR?",
  "play.practice": "PRÁCTICA",
  "play.practice.sub": "Aprende un gesto cada vez",
  "play.friendly": "AMISTOSO",
  "play.friendly.sub": "Un partido rápido contra la CPU",
  "play.competition": "COMPETICIÓN",
  "play.competition.sub": "Construye tu camino",
  "play.online": "EN LÍNEA",
  "play.online.sub": "Juega contra alguien, esté donde esté",

  "difficulty.title": "DIFICULTAD",
  "difficulty.sub": "¿Cuánto quieres que apriete la CPU?",
  "difficulty.easy": "FÁCIL",
  "difficulty.easy.sub": "Espacio para aprender el peloteo",
  "difficulty.normal": "NORMAL",
  "difficulty.normal.sub": "Un partido justo",
  "difficulty.hard": "DIFÍCIL",
  "difficulty.hard.sub": "Castiga cualquier balón suelto",

  "comp.title": "COMPETICIÓN",
  "comp.sub": "Construye tu camino.",
  "comp.cup": "COPA",
  "comp.cup.sub": "Eliminatorias hasta la final",
  "comp.league": "LIGA",
  "comp.league.sub": "Tres jornadas. Cada resultado cuenta.",

  "online.title": "JUGAR EN LÍNEA",
  "online.sub": "Juega contra alguien, esté donde esté.",
  "online.quick": "PARTIDA RÁPIDA",
  "online.quick.sub": "Te emparejamos con otro jugador",
  "online.friend": "JUGAR CON UN AMIGO",
  "online.friend.sub": "Crea una partida y comparte el código",
  "online.code": "INTRODUCIR CÓDIGO",
  "online.code.sub": "Únete a la partida de un amigo",
  "online.unavailable": "El juego en línea no está disponible en esta versión.",

  "settings.title": "AJUSTES",
  "settings.display": "PANTALLA",
  "settings.display.sub": "Gráficos, cámara e idioma",
  "settings.gameplay": "JUEGO",
  "settings.gameplay.sub": "Cuánto te ayuda el juego",
  "settings.audio": "AUDIO",
  "settings.audio.sub": "Música y efectos de sonido",
  "settings.graphics": "Gráficos",
  "settings.graphics.hint": "Detalle frente a fluidez",
  "settings.graphics.warning": "Cambiar esto reinicia el juego.",
  "settings.camera": "Cámara",
  "settings.camera.hint": "La vista al empezar un partido",
  "settings.camera.court": "Pista",
  "settings.camera.side": "Lateral",
  "settings.camera.top": "Cenital",
  "settings.language": "Idioma",
  "settings.language.hint": "Menús y textos en pantalla",
  "settings.autoReception": "Recepción automática",
  "settings.autoReception.hint": "Estar cerca del balón basta para el primer toque",
  "settings.music": "Música",
  "settings.music.hint": "Bucles de menú y partido",
  "settings.sound": "Efectos de sonido",
  "settings.sound.hint": "Golpeos, botes y público",
  "settings.restart.title": "REINICIAR",
  "settings.restart.body":
    "Cambiar los gráficos reconstruye la escena: el juego vuelve a la pantalla de inicio.",
  "settings.restart.confirm": "REINICIAR AHORA",
  "settings.restart.cancel": "CANCELAR",

  "select.title": "PREPARA TU EQUIPO",
  "select.player": "JUGADOR",
  "select.ball": "BALÓN",
  "select.play": "JUGAR",
  "select.loading": "Cargando…",
  "select.abilities.reactivity": "REACCIÓN",
  "select.abilities.power": "POTENCIA",
  "select.abilities.control": "CONTROL",
  "select.strongFoot": "PIE BUENO",
  "select.height": "ALTURA",
  "select.twoFooted": "AMBIDIESTRO",
  "select.left": "IZQUIERDO",
  "select.right": "DERECHO",

  "hud.you": "TÚ",
  "hud.cpu": "CPU",
  "pause.title": "EN PAUSA",
  "pause.resume": "CONTINUAR",
  "pause.quit": "SALIR AL MENÚ",
  "end.rematch": "REVANCHA",
  "end.change": "CAMBIAR EQUIPO",

  // — career —
  "career.coins": "MONEDAS",
  "career.trophies": "TROFEOS",
  "career.champions": "CAMPEONES",
  "career.champions.sub": "Tu plantilla, y cómo hacerla crecer",
  "career.challenges": "DESAFÍOS",
  "career.challenges.sub": "Tres al día. Se reinician a medianoche.",
  "career.level": "NIVEL",
  "career.locked": "BLOQUEADO",
  "career.unlockAt": "Se desbloquea con {n} trofeos",
  "career.upgrade": "MEJORAR",
  "career.maxLevel": "AL MÁXIMO",
  "career.cannotAfford": "No hay monedas suficientes",
  "career.nextLevel": "{n} partidos más para el siguiente nivel",
  "career.precision": "PRECISIÓN",
  "career.power": "PODER TOTAL",
  "career.selected": "SELECCIONADO",
  "career.resetsIn": "Se reinicia en {t}",
  "career.claim": "RECOGER",
  "career.claimed": "RECOGIDO",
  "career.rank": "RANGO",
  "career.promoted": "ASCENDIDO",
  "career.relegated": "DESCENDIDO",
  "career.nextRank": "{n} para {tier}",
  "career.topRank": "Cima de la clasificación",
  "career.reward": "RECOMPENSA",
  "career.empty": "Juega un partido para empezar tu carrera.",

  // — account —
  "profile.title": "TU PERFIL",
  "profile.signedOut": "JUEGA CON TU PROPIO NOMBRE",
  "profile.why": "Un nombre en la clasificación, trofeos que te siguen al próximo móvil, y un rival que sabe contra quién acaba de jugar.",
  "profile.name": "Tu nombre",
  "profile.create": "CREAR PERFIL",
  "profile.creating": "Creando…",
  "profile.warning": "El perfil vive en este dispositivo. No hay contraseña para recuperarlo, así que guarda tu código a buen recaudo.",
  "profile.fresh": "Un perfil nuevo empieza de cero. Tus {n} trofeos siguen en este dispositivo, pero no estarán en la clasificación.",
  "profile.code": "TU CÓDIGO",
  "profile.codeHint": "Compártelo para que te encuentren.",
  "profile.rename": "CAMBIAR NOMBRE",
  "profile.matches": "PARTIDOS",
  "profile.rank": "PUESTO MUNDIAL",
  "profile.leaderboard": "CLASIFICACIÓN",
  "profile.offline": "No se puede contactar con el servidor. El juego sigue sin él.",
  "profile.unranked": "Sin clasificar",
  "name.short": "Un poco más largo, por favor.",
  "name.long": "Demasiado largo para una tarjeta.",
  "name.characters": "Solo letras, números, espacios, - y _.",
  "board.title": "CLASIFICACIÓN",
  "board.sub": "{n} jugadores",
  "board.you": "TÚ",
  "board.empty": "Aún no ha jugado nadie. Empieza tú.",

  "challenge.matches": "Juega {n} partidos",
  "challenge.wins": "Gana {n} partidos",
  "challenge.points": "Anota {n} puntos",
  "challenge.rallies": "Juega {n} peloteos largos",
  "challenge.sets": "Gana {n} sets",
  "challenge.matches.one": "Juega un partido",
  "challenge.wins.one": "Gana un partido",
  "challenge.points.one": "Anota un punto",
  "challenge.rallies.one": "Juega un peloteo largo",
  "challenge.sets.one": "Gana un set",

  // — results —
  "result.win": "PARTIDO GANADO",
  "result.loss": "PARTIDO PERDIDO",
  "result.trophies": "TROFEOS",
  "result.coins": "MONEDAS",
  "result.levelUp": "SUBIDA DE NIVEL",
  "result.challengeDone": "DESAFÍO COMPLETADO",
  "result.continue": "CONTINUAR",

  // — loading tips —
  "tip.power": "Un deslizamiento lento eleva la pelota. Uno rápido la tensa.",
  "tip.setup": "Toca donde quieres la pelota, no donde quieres estar tú.",
  "tip.deep": "Una preparación profunda abre la definición.",
  "tip.reception": "Quédate cerca de la pelota: el primer toque se hace solo.",
  "tip.miss": "Golpeada a fondo, a veces se irá larga. Ese es el precio.",
  "tip.serve": "Saca abierto para sacarlo de la mesa.",

  "loading.court": "Preparando la pista…",
  "loading.match": "Preparando el partido…",
};

const PT: Catalogue = {
  "title.kicker": "FUTEBOL DE MESA",
  "title.tagline": "Trocas rápidas na mesa curva.",
  "title.play": "JOGAR",
  "title.settings": "AJUSTES",

  "nav.back": "VOLTAR",
  "nav.done": "PRONTO",

  "play.title": "COMO QUER JOGAR?",
  "play.practice": "TREINO",
  "play.practice.sub": "Aprenda um gesto de cada vez",
  "play.friendly": "AMISTOSO",
  "play.friendly.sub": "Uma partida rápida contra a CPU",
  "play.competition": "COMPETIÇÃO",
  "play.competition.sub": "Construa a sua campanha",
  "play.online": "ONLINE",
  "play.online.sub": "Jogue com alguém, onde quer que esteja",

  "difficulty.title": "DIFICULDADE",
  "difficulty.sub": "Quanto a CPU deve exigir de si?",
  "difficulty.easy": "FÁCIL",
  "difficulty.easy.sub": "Espaço para aprender a troca",
  "difficulty.normal": "NORMAL",
  "difficulty.normal.sub": "Um jogo justo",
  "difficulty.hard": "DIFÍCIL",
  "difficulty.hard.sub": "Castiga qualquer bola mal jogada",

  "comp.title": "COMPETIÇÃO",
  "comp.sub": "Construa a sua campanha.",
  "comp.cup": "TAÇA",
  "comp.cup.sub": "Eliminatórias até à final",
  "comp.league": "LIGA",
  "comp.league.sub": "Três jornadas. Cada resultado conta.",

  "online.title": "JOGAR ONLINE",
  "online.sub": "Jogue com alguém, onde quer que esteja.",
  "online.quick": "PARTIDA RÁPIDA",
  "online.quick.sub": "Encontramos um adversário por si",
  "online.friend": "JOGAR COM UM AMIGO",
  "online.friend.sub": "Crie um jogo e partilhe o código",
  "online.code": "INTRODUZIR CÓDIGO",
  "online.code.sub": "Entre no jogo de um amigo",
  "online.unavailable": "O jogo online não está disponível nesta versão.",

  "settings.title": "AJUSTES",
  "settings.display": "ECRÃ",
  "settings.display.sub": "Gráficos, câmara e idioma",
  "settings.gameplay": "JOGO",
  "settings.gameplay.sub": "Quanto o jogo o ajuda",
  "settings.audio": "ÁUDIO",
  "settings.audio.sub": "Música e efeitos sonoros",
  "settings.graphics": "Gráficos",
  "settings.graphics.hint": "Detalhe contra fluidez",
  "settings.graphics.warning": "Alterar isto reinicia o jogo.",
  "settings.camera": "Câmara",
  "settings.camera.hint": "A vista com que a partida começa",
  "settings.camera.court": "Campo",
  "settings.camera.side": "Lateral",
  "settings.camera.top": "Superior",
  "settings.language": "Idioma",
  "settings.language.hint": "Menus e texto no ecrã",
  "settings.autoReception": "Receção automática",
  "settings.autoReception.hint": "Estar perto da bola chega para o primeiro toque",
  "settings.music": "Música",
  "settings.music.hint": "Músicas de menu e de jogo",
  "settings.sound": "Efeitos sonoros",
  "settings.sound.hint": "Remates, ressaltos e público",
  "settings.restart.title": "REINICIAR",
  "settings.restart.body":
    "Alterar os gráficos reconstrói a cena: o jogo volta ao ecrã inicial.",
  "settings.restart.confirm": "REINICIAR AGORA",
  "settings.restart.cancel": "CANCELAR",

  "select.title": "PREPARE A SUA EQUIPA",
  "select.player": "JOGADOR",
  "select.ball": "BOLA",
  "select.play": "JOGAR",
  "select.loading": "A carregar…",
  "select.abilities.reactivity": "REAÇÃO",
  "select.abilities.power": "POTÊNCIA",
  "select.abilities.control": "CONTROLO",
  "select.strongFoot": "PÉ BOM",
  "select.height": "ALTURA",
  "select.twoFooted": "AMBIDESTRO",
  "select.left": "ESQUERDO",
  "select.right": "DIREITO",

  "hud.you": "VOCÊ",
  "hud.cpu": "CPU",
  "pause.title": "EM PAUSA",
  "pause.resume": "CONTINUAR",
  "pause.quit": "SAIR PARA O MENU",
  "end.rematch": "REVANCHA",
  "end.change": "MUDAR EQUIPA",

  // — career —
  "career.coins": "MOEDAS",
  "career.trophies": "TROFÉUS",
  "career.champions": "CAMPEÕES",
  "career.champions.sub": "O teu plantel, e como o fazer crescer",
  "career.challenges": "DESAFIOS",
  "career.challenges.sub": "Três por dia. Recomeçam à meia-noite.",
  "career.level": "NÍVEL",
  "career.locked": "BLOQUEADO",
  "career.unlockAt": "Desbloqueia com {n} troféus",
  "career.upgrade": "MELHORAR",
  "career.maxLevel": "NO MÁXIMO",
  "career.cannotAfford": "Moedas insuficientes",
  "career.nextLevel": "Mais {n} jogos para o próximo nível",
  "career.precision": "PRECISÃO",
  "career.power": "PODER TOTAL",
  "career.selected": "SELECIONADO",
  "career.resetsIn": "Recomeça em {t}",
  "career.claim": "RECEBER",
  "career.claimed": "RECEBIDO",
  "career.rank": "CLASSE",
  "career.promoted": "PROMOVIDO",
  "career.relegated": "DESPROMOVIDO",
  "career.nextRank": "{n} para {tier}",
  "career.topRank": "Topo da tabela",
  "career.reward": "RECOMPENSA",
  "career.empty": "Joga um jogo para começar a tua carreira.",

  // — account —
  "profile.title": "O TEU PERFIL",
  "profile.signedOut": "JOGA COM O TEU NOME",
  "profile.why": "Um nome na tabela, troféus que te seguem para o próximo telemóvel, e um adversário que sabe contra quem jogou.",
  "profile.name": "O teu nome",
  "profile.create": "CRIAR PERFIL",
  "profile.creating": "A criar…",
  "profile.warning": "O perfil vive neste dispositivo. Não há palavra-passe para o recuperar, por isso guarda bem o teu código.",
  "profile.fresh": "Um perfil novo começa do zero. Os teus {n} troféus ficam neste dispositivo, mas não vão para a tabela.",
  "profile.code": "O TEU CÓDIGO",
  "profile.codeHint": "Partilha-o para te encontrarem.",
  "profile.rename": "MUDAR O NOME",
  "profile.matches": "JOGOS",
  "profile.rank": "LUGAR MUNDIAL",
  "profile.leaderboard": "TABELA",
  "profile.offline": "Servidor inacessível de momento. O jogo continua sem ele.",
  "profile.unranked": "Sem lugar",
  "name.short": "Um pouco mais longo, por favor.",
  "name.long": "Demasiado longo para um cartão.",
  "name.characters": "Só letras, números, espaços, - e _.",
  "board.title": "TABELA",
  "board.sub": "{n} jogadores",
  "board.you": "TU",
  "board.empty": "Ainda ninguém jogou. Começa tu.",

  "challenge.matches": "Joga {n} jogos",
  "challenge.wins": "Ganha {n} jogos",
  "challenge.points": "Marca {n} pontos",
  "challenge.rallies": "Joga {n} trocas longas",
  "challenge.sets": "Ganha {n} sets",
  "challenge.matches.one": "Joga um jogo",
  "challenge.wins.one": "Ganha um jogo",
  "challenge.points.one": "Marca um ponto",
  "challenge.rallies.one": "Joga uma troca longa",
  "challenge.sets.one": "Ganha um set",

  // — results —
  "result.win": "JOGO GANHO",
  "result.loss": "JOGO PERDIDO",
  "result.trophies": "TROFÉUS",
  "result.coins": "MOEDAS",
  "result.levelUp": "SUBIU DE NÍVEL",
  "result.challengeDone": "DESAFIO CONCLUÍDO",
  "result.continue": "CONTINUAR",

  // — loading tips —
  "tip.power": "Um deslize lento levanta a bola. Um rápido baixa-a.",
  "tip.setup": "Toca onde queres a bola, não onde queres estar.",
  "tip.deep": "Uma preparação funda abre a finalização.",
  "tip.reception": "Fica perto da bola: o primeiro toque acontece sozinho.",
  "tip.miss": "Batida com tudo, às vezes sai. É o preço da velocidade.",
  "tip.serve": "Serve aberto para o tirar da mesa.",

  "loading.court": "A preparar o campo…",
  "loading.match": "A preparar a partida…",
};

const CATALOGUES: Record<Language, Catalogue> = { en: EN, fr: FR, es: ES, pt: PT };

let current: Language = "en";

/** The language in use. */
export function language(): Language {
  return current;
}

export function setLanguage(next: Language): void {
  current = next;
  if (typeof document !== "undefined") document.documentElement.lang = next;
}

/** The best match for the device's own language, or English. */
export function detectLanguage(): Language {
  if (typeof navigator === "undefined") return "en";
  for (const tag of navigator.languages ?? [navigator.language]) {
    const base = String(tag).slice(0, 2).toLowerCase();
    const match = LANGUAGES.find((l) => l.id === base);
    if (match) return match.id;
  }
  return "en";
}

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.some((l) => l.id === value);
}

/** Look up one string in the current language. */
export function t(key: StringKey): string {
  return CATALOGUES[current][key] ?? EN[key];
}

/**
 * A translated string with its placeholders filled in.
 *
 * Placeholders are named (`{n}`, `{tier}`) rather than positional because word
 * order is the first thing a translation changes: "3 to ROOKIE II" and "3 pour
 * ROOKIE II" happen to agree, but nothing guarantees the next language will.
 */
export function tf(key: StringKey, values: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in values ? String(values[name]) : whole
  );
}
