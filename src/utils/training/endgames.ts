// Theoretical endgames, played against the perfect defence of the Lichess tablebases.
// Every position was checked for legality and for its result (Stockfish, which knows
// king-and-pawn endings exactly); the app checks it again against the tablebase when
// the exercise starts.

export type EndgameChapter = "mates" | "pawns" | "rooks" | "pieces" | "complex";

export const CHAPTERS: { id: EndgameChapter; title: string }[] = [
    { id: "mates", title: "Matti elementari" },
    { id: "pawns", title: "Re e pedoni" },
    { id: "rooks", title: "Finali di torre" },
    { id: "pieces", title: "Donna e pezzi contro pedoni" },
    { id: "complex", title: "Finali complessi" },
];

export type Endgame = {
    id: string;
    chapter: EndgameChapter;
    title: string;
    /** You play the side to move. */
    fen: string;
    goal: "win" | "draw";
    /**
     * When a win counts as done: checkmate, your promotion, or the opponent left with the
     * bare king (pawn or piece won).
     */
    stop?: "mate" | "promotion" | "capture";
    /** Most moves you may need to win (default 40). */
    limit?: number;
    /** Moves to hold for a draw (default 12), unless the game ends drawn first. */
    hold?: number;
    /** The idea, shown before you start. */
    idea: string;
};

export const ENDGAMES: Endgame[] = [
    // Elementary mates
    {
        id: "mate-queen",
        chapter: "mates",
        title: "Donna e re contro re",
        fen: "8/8/8/4k3/8/8/8/3QK3 w - - 0 1",
        goal: "win",
        stop: "mate",
        limit: 20,
        idea: "Restringi il re nero con la donna (a un salto di cavallo da lui), poi avvicina il tuo re. Attento allo stallo quando il re nero è sul bordo.",
    },
    {
        id: "mate-two-rooks",
        chapter: "mates",
        title: "Matto a scala con due torri",
        fen: "4k3/8/8/8/8/8/8/R3K2R w - - 0 1",
        goal: "win",
        stop: "mate",
        limit: 10,
        idea: "Le torri si danno il cambio: una taglia la traversa, l'altra dà scacco sulla successiva. Se il re si avvicina a una torre, spostala sull'altro lato.",
    },
    {
        id: "mate-rook",
        chapter: "mates",
        title: "Torre e re contro re",
        fen: "8/8/8/3k4/8/8/8/R3K3 w - - 0 1",
        goal: "win",
        stop: "mate",
        limit: 30,
        idea: "La torre taglia il re nero, il tuo re si avvicina. Quando i re sono di fronte (opposizione), lo scacco di torre lo spinge indietro di una traversa.",
    },
    {
        id: "mate-bishops",
        chapter: "mates",
        title: "Due alfieri",
        fen: "8/8/3k4/8/8/8/8/2B1KB2 w - - 0 1",
        goal: "win",
        stop: "mate",
        limit: 30,
        idea: "Gli alfieri affiancati formano un muro di diagonali: restringi il re verso un angolo qualsiasi e porta il tuo re a sostegno. Attento allo stallo.",
    },
    // King and pawns
    {
        id: "pawns-square",
        chapter: "pawns",
        title: "La regola del quadrato",
        fen: "7k/8/8/p7/8/5K2/8/8 w - - 0 1",
        goal: "draw",
        idea: "Il re ferma il pedone se entra nel suo quadrato (dalla casa del pedone fino alla traversa di promozione). Da f3 solo verso la colonna e ci riesci.",
    },
    {
        id: "pawns-sixth",
        chapter: "pawns",
        title: "Re in sesta davanti al pedone",
        fen: "4k3/8/4K3/4P3/8/8/8/8 w - - 0 1",
        goal: "win",
        stop: "promotion",
        idea: "Con il re in sesta davanti al pedone (non di torre) si vince sempre: mettiti di fianco al re nero, poi il pedone avanza.",
    },
    {
        id: "pawns-opposition",
        chapter: "pawns",
        title: "L'opposizione",
        fen: "8/8/4k3/8/3K4/4P3/8/8 w - - 0 1",
        goal: "win",
        stop: "promotion",
        idea: "Il re va davanti al pedone, non dietro, prendendo l'opposizione: i re si fronteggiano a una casa di distanza e tocca all'avversario cedere il passo.",
    },
    {
        id: "pawns-opposition-defence",
        chapter: "pawns",
        title: "Difendi con l'opposizione",
        fen: "8/8/4k3/8/3K4/4P3/8/8 b - - 0 1",
        goal: "draw",
        idea: "Prendi tu l'opposizione davanti al re bianco e mantienila; quando il pedone avanza, il tuo re resta davanti a lui.",
    },
    {
        id: "pawns-critical",
        chapter: "pawns",
        title: "Le case critiche",
        fen: "8/8/8/4k3/8/2K5/3P4/8 w - - 0 1",
        goal: "win",
        stop: "promotion",
        idea: "Con il pedone in d2 le case critiche sono c4, d4 ed e4: se il tuo re ne occupa una si vince, anche lasciando il pedone indietro.",
    },
    {
        id: "pawns-rook-pawn",
        chapter: "pawns",
        title: "Pedone di torre: corri nell'angolo",
        fen: "8/3k4/8/PK6/8/8/8/8 b - - 0 1",
        goal: "draw",
        idea: "Contro il pedone di torre basta che il tuo re arrivi davanti al pedone o nell'angolo: il re bianco non può cacciarti senza dare stallo.",
    },
    {
        id: "pawns-outside",
        chapter: "pawns",
        title: "Il pedone passato lontano",
        fen: "8/8/3k4/6p1/P5P1/3K4/8/8 w - - 0 1",
        goal: "win",
        stop: "promotion",
        limit: 30,
        idea: "Il pedone a attira il re nero lontano; intanto il tuo re va a prendere i pedoni sull'altro lato.",
    },
    // Rook endgames
    {
        id: "rooks-lucena",
        chapter: "rooks",
        title: "Lucena: costruisci il ponte",
        fen: "1K1k4/1P6/8/8/8/8/r7/2R5 w - - 0 1",
        goal: "win",
        stop: "promotion",
        idea: "Allontana il re nero con uno scacco (Td1+), porta la torre in quarta (Td4) e fai uscire il tuo re: la torre farà da scudo agli scacchi laterali.",
    },
    {
        id: "rooks-philidor",
        chapter: "rooks",
        title: "Difesa di Philidor",
        fen: "4k3/R7/1r6/4PK2/8/8/8/8 b - - 0 1",
        goal: "draw",
        hold: 15,
        idea: "La torre resta sulla sesta traversa e impedisce al re bianco di avanzare. Quando il pedone arriva in sesta, la torre va in fondo e dà scacchi da dietro.",
    },
    {
        id: "rooks-vancura",
        chapter: "rooks",
        title: "Difesa di Vancura",
        fen: "R7/6k1/P4r2/1K6/8/8/8/8 b - - 0 1",
        goal: "draw",
        hold: 15,
        idea: "Contro il pedone di torre in sesta, la torre lo attacca di lato dalla stessa traversa; quando il re bianco si avvicina per difenderlo, scacchi.",
    },
    {
        id: "rooks-seventh",
        chapter: "rooks",
        title: "Torre davanti al pedone in settima",
        fen: "R7/P5k1/8/8/8/8/r7/6K1 b - - 0 1",
        goal: "draw",
        hold: 15,
        idea: "Il re sta in g7/h7, la torre dietro al pedone: la torre bianca è bloccata davanti al pedone. Non lasciare le case g7 e h7.",
    },
    {
        id: "rooks-cut-off",
        chapter: "rooks",
        title: "Re tagliato fuori",
        fen: "7r/8/5k2/3P4/3K4/8/8/4R3 w - - 0 1",
        goal: "win",
        stop: "promotion",
        limit: 40,
        idea: "La torre in colonna e tiene il re nero lontano dal pedone. Avanza con re e pedone insieme, riparando il re dagli scacchi.",
    },
    // Queen and pieces against pawns
    {
        id: "pieces-queen-centre",
        chapter: "pieces",
        title: "Donna contro pedone centrale in settima",
        fen: "Q7/8/8/8/8/8/3pk3/7K w - - 0 1",
        goal: "win",
        stop: "capture",
        limit: 30,
        idea: "Con scacchi e inchiodature costringi il re nero davanti al suo pedone: a ogni tempo guadagnato avvicini il tuo re, poi prendi il pedone.",
    },
    {
        id: "pieces-queen-bishop-pawn",
        chapter: "pieces",
        title: "Donna contro pedone d'alfiere: lo stallo",
        fen: "8/8/8/8/1Q6/8/2pk4/7K b - - 0 1",
        goal: "draw",
        idea: "Tieni il re accanto al pedone. Con il pedone d'alfiere, se il Bianco lo blocca puoi rifugiarti nell'angolo: prendere il pedone sarebbe stallo.",
    },
    {
        id: "pieces-rook-pawn",
        chapter: "pieces",
        title: "Torre contro pedone",
        fen: "8/8/8/8/3pk3/8/8/2K4R w - - 0 1",
        goal: "win",
        stop: "capture",
        limit: 20,
        idea: "Taglia il re nero con la torre e porta il tuo re davanti al pedone: quando il pedone resta solo, lo prendi.",
    },
    {
        id: "pieces-knight-pawn",
        chapter: "pieces",
        title: "Cavallo contro pedone",
        fen: "8/8/8/8/8/1p6/8/K1k1N3 w - - 0 1",
        goal: "draw",
        idea: "Il cavallo deve controllare la casa di promozione o dare scacco al momento giusto per guadagnare il tempo che serve a fermare il pedone.",
    },
    {
        id: "pieces-wrong-bishop",
        chapter: "pieces",
        title: "L'alfiere sbagliato",
        fen: "8/8/3k4/P7/1K6/8/8/B7 b - - 0 1",
        goal: "draw",
        idea: "Pedone di torre e alfiere che non controlla la casa di promozione: se il tuo re arriva nell'angolo davanti al pedone, è patta. Corri verso c7 e b8.",
    },
    // Complex endgames
    {
        id: "complex-bishop-knight",
        chapter: "complex",
        title: "Matto con alfiere e cavallo",
        fen: "8/8/8/4k3/8/8/8/2B1K1N1 w - - 0 1",
        goal: "win",
        stop: "mate",
        limit: 50,
        idea: "Il matto si dà solo nell'angolo del colore dell'alfiere (qui a1 o h8). Spingi il re al bordo, poi lungo il bordo verso l'angolo giusto con la manovra a W del cavallo.",
    },
    {
        id: "complex-queen-rook",
        chapter: "complex",
        title: "Donna contro torre",
        fen: "8/8/4k3/8/8/2r5/8/1K5Q w - - 0 1",
        goal: "win",
        stop: "capture",
        limit: 40,
        idea: "Con scacchi e minacce separa la torre dal re nero: la torre lontana dal suo re finisce in una forchetta. Spingi il re nero al bordo prima.",
    },
    {
        id: "complex-rook-bishop",
        chapter: "complex",
        title: "Torre contro alfiere: l'angolo giusto",
        fen: "8/8/8/8/8/1b6/8/k3K2R b - - 0 1",
        goal: "draw",
        hold: 15,
        idea: "Il re in difesa va nell'angolo del colore opposto a quello dell'alfiere (qui a1 o h8): lì non c'è matto. L'alfiere resta vicino al re.",
    },
];

export function endgameById(id: string): Endgame | undefined {
    return ENDGAMES.find((e) => e.id === id);
}
