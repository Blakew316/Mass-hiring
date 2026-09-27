// Sales IQ question bank — copied verbatim from the Sales IQ app (js/questions.js).
// The points live only here, on the server: a candidate's browser is sent the
// question and option text and nothing else, and the score is worked out when
// their answers arrive. Keep 4 options per question and a maximum of 10 points;
// everything else (progress, scoring, breakdown) adapts.

/* =========================================================
   Question bank — 10 questions, 5 competencies × 2 each.
   Every option is written to sound defensible; scoring
   (1–10 per question, max total = 100) separates real sales
   instincts from plausible-sounding answers. Scores are
   never shown to the candidate.

   The strongest option for each question reflects:
     Q1  rejection      — persistence, quick reset, learning from the no
     Q2  tough deal     — clear thinking, ownership, mid-course adjustment
     Q3  rapport        — listening before pitching, earned credibility
     Q4  lead priority  — qualification and strategy over raw activity
     Q5  client needs   — questioning skill, digging past surface answers
     Q6  hitting target — owned, repeatable process; consistency not luck
     Q7  objections     — composure, addressing the real concern directly
     Q8  learning       — self-driven improvement, openness to feedback
     Q9  team selling   — collaboration without losing ownership
     Q10 motivation     — internal drive and discipline through slumps
   ========================================================= */

const CATEGORIES = {
  resilience: { name: "Resilience & Motivation",           blurb: "Handling rejection and staying driven through slumps" },
  problem:    { name: "Problem-Solving & Objections",      blurb: "Composure and control when deals get hard" },
  client:     { name: "Client Rapport & Discovery",        blurb: "Building trust and uncovering real needs" },
  strategy:   { name: "Strategy & Results",                blurb: "Prioritization, process, and ownership of outcomes" },
  growth:     { name: "Coachability & Teamwork",           blurb: "Improving over time and winning with others" },
};

const QUESTIONS = [
  {
    category: "resilience",
    text: "How do you handle rejection?",
    options: [
      { text: "I step away for a bit to clear my head, so the frustration never shows in my next conversation.", points: 3 },
      { text: "I give it about thirty seconds — pull one thing worth learning from the no, then make the next call. A rejection only costs me if I carry it into the next conversation.", points: 10 },
      { text: "I remind myself it's a numbers game — keep the activity up and the yeses take care of themselves.", points: 6 },
      { text: "I try to limit it up front by focusing on prospects who've already shown real interest.", points: 1 },
    ],
  },
  {
    category: "problem",
    text: "A deal you've worked for weeks starts going sideways — the decision-maker goes quiet and you learn a competitor is suddenly in the mix. How do you handle it?",
    options: [
      { text: "Send a respectful check-in that gives them an easy way to tell me no, so at least I know where I stand.", points: 7 },
      { text: "Shift my energy to healthier prospects — deals that go quiet this late in the process rarely close.", points: 1 },
      { text: "Treat the silence as information: re-engage through another contact, find out what changed and what the competitor is offering, and rebuild my case around it.", points: 10 },
      { text: "Stay patient and give them space — chasing harder pushes buyers away, and if my value was clear they'll resurface.", points: 3 },
    ],
  },
  {
    category: "client",
    text: "How do you build rapport with clients?",
    options: [
      { text: "Ask about their business before I say a word about mine, and listen for what they actually care about — trust comes from proving I understand their world, not from being charming.", points: 10 },
      { text: "Find common ground fast — a shared interest or mutual connection breaks the wall down quicker than anything.", points: 6 },
      { text: "Match their energy and keep things light — at the end of the day, people buy from people they like.", points: 2 },
      { text: "Be direct about what I'm offering and respect their time — professionalism builds more trust than small talk.", points: 4 },
    ],
  },
  {
    category: "strategy",
    text: "You've got more leads than hours. How do you prioritize them?",
    options: [
      { text: "Give every lead the same effort — you never know where the big deal is hiding, and skipped leads are lost revenue.", points: 1 },
      { text: "Work them in order with fast follow-up — speed to lead beats overthinking the list.", points: 6 },
      { text: "Rank them by fit and likely value — who matches our best customers, who has a reason to act now — give my prime hours to those, and disqualify the rest quickly.", points: 10 },
      { text: "Start with the warmest ones — interested prospects close faster than good-fit ones who've never heard of us.", points: 3 },
    ],
  },
  {
    category: "client",
    text: "How do you uncover what a client actually needs?",
    options: [
      { text: "Research them before the meeting so I already know their likely needs and can speak to them directly.", points: 4 },
      { text: "Ask them straight out what they're looking for — clients know what they need; my job is to deliver it.", points: 2 },
      { text: "Watch their reactions while I present — what they lean into during the demo tells me what matters.", points: 6 },
      { text: "Ask open questions about how they run things today and what it's costing them, then keep digging on the answers — the second and third \"why\" is where the real need lives.", points: 10 },
    ],
  },
  {
    category: "strategy",
    text: "Think about the times you've hit or beaten your sales target. Which best describes what actually got you there?",
    options: [
      { text: "Turning it on when it counted — when the month was slipping, I found another gear and pulled deals over the line.", points: 6 },
      { text: "A repeatable weekly process — set activity numbers, tracked ratios, and a quick adjustment whenever a ratio slipped. My best stretches were the ones where I followed it hardest.", points: 10 },
      { text: "Strong relationships — referrals and repeat business kept the pipeline fed without much cold work.", points: 3 },
      { text: "Landing a couple of big accounts — one whale can make your whole year.", points: 1 },
    ],
  },
  {
    category: "problem",
    text: "How do you handle objections?",
    options: [
      { text: "Prevent them — a strong enough presentation answers the objections before they ever come up.", points: 3 },
      { text: "Preparation — I know the common objections cold and have a tested response ready for each one.", points: 6 },
      { text: "Concede quickly where they have a point and steer back to our strengths — arguing with prospects loses deals.", points: 1 },
      { text: "Slow down and get curious — acknowledge it, ask questions until I understand what's really behind it, then answer that. Half the time the stated objection isn't the real one.", points: 10 },
    ],
  },
  {
    category: "growth",
    text: "How do you approach getting better at sales?",
    options: [
      { text: "Deliberately — I review my lost deals and recorded calls, ask for coaching on the weak spots, and work on one improvement at a time until it sticks.", points: 10 },
      { text: "Books, podcasts, and watching top performers — I study what the best do and borrow whatever fits my style.", points: 6 },
      { text: "Reps — experience is the best teacher, and every year in the field makes you better if you're paying attention.", points: 4 },
      { text: "I've found an approach that works and I stick to it — constantly switching techniques is how pipelines fall apart.", points: 1 },
    ],
  },
  {
    category: "growth",
    text: "A big deal needs your operations team, your manager, and a technical specialist to get across the line. How do you run it?",
    options: [
      { text: "Hand the technical pieces to the specialists and step back in at the end, when it's time to ask for the business.", points: 3 },
      { text: "Stay the owner — brief each person on what the client cares about and where the deal stands, coordinate who covers what, and make sure the client hears one consistent story.", points: 10 },
      { text: "Bring my manager in to lead the close — seniority moves big deals, and I'd rather share the credit than lose the deal.", points: 6 },
      { text: "Keep the circle as small as possible — every extra voice is a chance for someone to say the wrong thing.", points: 1 },
    ],
  },
  {
    category: "resilience",
    text: "How do you stay motivated during tough stretches?",
    options: [
      { text: "I reconnect with what I'm working toward — my goals and the people counting on me pull me through the slow weeks.", points: 6 },
      { text: "I change things up — a new script, a new angle on the territory, anything that makes the work feel fresh again.", points: 3 },
      { text: "I fall back on discipline — my activity numbers don't depend on my mood. I control the inputs and trust the slump breaks before the work does.", points: 10 },
      { text: "I lean on the team's energy and my manager's encouragement to keep my head right.", points: 1 },
    ],
  },
];

const MAX_POINTS_PER_QUESTION = 10;

const TIERS = [
  {
    min: 85, key: "elite", label: "Elite Talent",
    blurb: "Top-tier instincts across the board — resilience, disciplined process, real discovery skills, and composure under pressure. Shows the makeup of a future top producer; move quickly.",
  },
  {
    min: 70, key: "strong", label: "Strong Potential",
    blurb: "Consistently sound instincts with a few coachable gaps. With structured ramp-up and coaching, projects as a solid quota-carrier.",
  },
  {
    min: 50, key: "develop", label: "Developing",
    blurb: "Mixed judgment — some strong reads alongside answers that favor comfort, luck, or outside help over ownership. Probe the weakest competencies in a follow-up interview.",
  },
  {
    min: 0, key: "notready", label: "Not Sales-Ready",
    blurb: "Responses consistently avoid the harder selling behaviors — owning results, working through rejection, digging for real needs. Unlikely to succeed in a quota-carrying role today.",
  },
];

function tierForScore(score) {
  return TIERS.find((t) => score >= t.min) || TIERS[TIERS.length - 1];
}

module.exports = { CATEGORIES, QUESTIONS, MAX_POINTS_PER_QUESTION, TIERS, tierForScore };
