export const CRIME_TAXONOMY = [
  {
    id: 'murder',
    category: 'murder',
    title: 'Murder or homicide',
    description: 'Intentional killing, lynching, mob killing, murder case, homicide, death after violent attack.',
    examples: [
      'mob beats a man to death in Chennai',
      'two youths killed by armed gang',
      'murder case registered by police'
    ]
  },
  {
    id: 'rape',
    category: 'rape',
    title: 'Rape or sexual assault',
    description: 'Rape, gang rape, molestation, sexual assault, POCSO, outrage of modesty.',
    examples: ['woman alleges rape', 'sexual assault case filed', 'POCSO case registered']
  },
  {
    id: 'assault',
    category: 'assault',
    title: 'Assault or violent attack',
    description: 'Beating, assault, violent attack, grievous hurt, non-fatal violent injuries.',
    examples: ['man attacked in market', 'auto driver assaulted', 'victim beaten in quarrel']
  },
  {
    id: 'robbery-theft',
    category: 'robbery/theft',
    title: 'Robbery, theft, burglary or snatching',
    description: 'Robbery, chain snatching, burglary, theft, loot, stolen valuables or vehicles.',
    examples: ['chain snatching in Adyar', 'robbery near bus stand', 'house burglary reported']
  },
  {
    id: 'kidnapping',
    category: 'kidnapping',
    title: 'Kidnapping or abduction',
    description: 'Kidnap, abduct, forced away, missing child with abduction or trafficking context.',
    examples: ['child kidnapped from school gate', 'abducted businessman rescued']
  },
  {
    id: 'fraud-scam',
    category: 'fraud/scam',
    title: 'Fraud, cybercrime or scam',
    description: 'Financial fraud, cyber scam, digital arrest scam, cheating, phishing or mule account network.',
    examples: ['digital arrest scamster held', 'victim cheated of Rs 1 crore', 'cyber fraud racket busted']
  },
  {
    id: 'drug-offense',
    category: 'drug offense',
    title: 'Drug offense or narcotics case',
    description: 'Drug smuggling, narcotics seizure, ganja sale, banned substance trafficking or possession.',
    examples: ['drugs seized in Chennai', 'smuggling and selling narcotics', 'ganja peddlers arrested']
  },
  {
    id: 'other',
    category: 'other',
    title: 'Other crime event',
    description: 'Crime-related event that is not captured by the main categories but is still a publishable incident.',
    examples: ['extortion case registered', 'illegal arms racket unearthed']
  },
  {
    id: 'not-a-crime-event',
    category: 'not-a-crime-event',
    title: 'Not a crime event',
    description: 'General city news, politics, weather, traffic, civic updates, legal analysis without a discrete incident.',
    examples: ['rain warning in Chennai', 'metro expansion announced', 'festival traffic diversions']
  }
];

export function buildTaxonomyDocument(entry) {
  return [entry.title, entry.description, `Examples: ${entry.examples.join('; ')}`].join('\n');
}
