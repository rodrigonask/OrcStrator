export type NamingTheme = 'fruits' | 'rpg' | 'wow' | 'memes' | 'corporate' | 'dev' | 'ops' | 'heist' | 'celeb'

export const THEME_LABELS: Record<NamingTheme, string> = {
  fruits: 'Fruits',
  rpg: 'RPG Characters',
  wow: 'World of Warcraft',
  memes: 'Meme Names',
  corporate: 'Corporate Lingo',
  dev: 'Dev Jokes',
  ops: 'Ops Codenames',
  heist: 'Heist Crew',
  celeb: 'Celebrity Puns',
}

// ────────────────────────────────────────────
// FRUITS  (~50)
// ────────────────────────────────────────────

const FRUITS = [
  '🍎 Apple', '🍊 Orange', '🍋 Lemon', '🍇 Grape', '🍓 Strawberry',
  '🫐 Blueberry', '🍒 Cherry', '🥭 Mango', '🍍 Pineapple', '🥝 Kiwi',
  '🍑 Peach', '🍈 Melon', '🍌 Banana', '🍐 Pear', '🥥 Coconut',
  '🍉 Watermelon', '🫒 Olive', '🍏 Lime', '🍅 Tomato', '🫙 Fig',
  '🫑 Pepper', '🥑 Avocado', '🍆 Eggplant', '🥦 Broccoli', '🌶️ Chili',
  '🧅 Onion', '🧄 Garlic', '🥕 Carrot', '🌽 Corn', '🍠 Yam',
  '🫛 Pea', '🥬 Lettuce', '🍓 Raspberry', '🫐 Acai', '🍒 Damson',
  '🍋 Yuzu', '🍊 Clementine', '🥝 Feijoa', '🍈 Cantaloupe', '🍎 Fuji',
  '🍐 Bosc', '🍇 Muscatel', '🍉 Honeydew', '🥭 Guava', '🍑 Nectarine',
  '🫙 Jackfruit', '🫚 Papaya', '🍅 Plum', '🍈 Quince', '🥥 Coconut Cream',
]

// ────────────────────────────────────────────
// RPG  (~50)
// ────────────────────────────────────────────

const RPG = [
  'Leroy Jenkins', 'Sephiroth', 'Cloud Strife', 'Cortana', 'Master Chief',
  'Geralt', 'Ciri', 'Gandalf', 'Frodo', 'Aragorn',
  'Link', 'Zelda', 'Ganon', 'Samus', 'Ridley',
  'Kratos', 'Atreus', 'Aloy', 'Nathan Drake', 'Solid Snake',
  'Lara Croft', 'Ezio', 'Altair', 'Bayek', 'Kassandra',
  'Commander Shepard', 'Liara', 'Garrus', 'Wrex', 'Mordin',
  'Dovahkiin', 'Lydia', 'Serana', 'Paarthurnax', 'Alduin',
  'Kaim Argonar', 'Noctis', 'Lightning', 'Tidus', 'Yuna',
  'Dante', 'Nero', 'V', 'Bayonetta', 'Nier',
  'Ryu', 'Ken', 'Chun-Li', 'Akuma', 'Blanka',
]

// ────────────────────────────────────────────
// WOW  (~50)
// ────────────────────────────────────────────

const WOW = [
  'Thrall', 'Sylvanas', 'Arthas', 'Jaina', 'Illidan',
  'Malfurion', 'Tyrande', 'Anduin', 'Varian', 'Garrosh',
  "Vol'jin", 'Baine', "Lor'themar", 'Gallywix', 'Genn',
  'Khadgar', 'Medivh', 'Antonidas', 'Rhonin', 'Krasus',
  "Kel'Thuzad", "Anub'arak", 'Lich King', 'Yogg-Saron', "C'thun",
  'Ragnaros', 'Nefarian', 'Onyxia', 'Deathwing', 'Murozond',
  'Chen Stormstout', 'Li Li', 'Xuen', "Yu'lon", 'Chi-Ji',
  'Archimonde', "Kil'jaeden", 'Sargeras', 'Azshara', "N'zoth",
  'Denathrius', 'Sire', 'Ysera', 'Alexstrasza', 'Nozdormu',
  "Mal'ganis", "Drak'thul", 'Bloodhoof', 'Stonemaul', 'Darkspear',
]

// ────────────────────────────────────────────
// MEMES  (~500 pun names)
// ────────────────────────────────────────────

const MEMES = [
  // ── A ──
  'Adam Baum', 'Adam Upp', 'Al Beback', 'Al Dente', 'Al Fresco',
  'Al K. Seltzer', 'Al O. Vera', 'Al Pha', 'Al Pine', 'Amanda Huginkiss',
  'Amber Alert', 'Amy Stake', 'Ana Conda', 'Ana Graham', 'Anita Bath',
  'Anita Break', 'Anita Job', 'Anita Napp', 'Ann Chovey', 'Ann Jection',
  'Anna Log', 'Anna Prentice', 'April May', 'April Showers', 'Art E. Fishel',
  'Artie Choke', 'Ash Ketchum', 'Ava Lanche', 'Ava Rado',
  // ── B ──
  'Bailey Hout', 'Barb Arian', 'Barb Dwyer', 'Barb Wire', 'Barry Cade',
  'Barry Cuda', "Barry D'Alive", 'Barry Tone', 'Basil Isk', 'Belle Bottoms',
  'Ben Dover', 'Ben D. Rules', 'Ben Effit', 'Ben There', 'Benny Ficial',
  'Bill Board', 'Bill Ding', 'Bill Fold', 'Bill Loney', 'Billy Goat',
  'Bob Frapples', 'Bob Sled', 'Bob Wire', 'Brad Wurst', 'Bran Muffin',
  'Bree Zing', 'Brock Lee', 'Brooke Trout', 'Bruce Allmighty', 'Buck Wheat',
  'Bud Wiser', 'Buster Limit', 'Buzz Killington',
  // ── C ──
  'Cal Culator', 'Cal Zone', 'Cam Ouflage', 'Cam Paign', 'Candi Barr',
  'Cara Van', 'Carl Ache', 'Carrie Oakey', 'Cash Flow', 'Ceil Ingfan',
  'Chip Monk', 'Chris Cross', 'Chris P. Bacon', 'Chuck Wagon', 'Cindy Rella',
  'Claire Voyant', 'Clay Mation', 'Cliff Hanger', 'Cliff Notes', 'Cole Slaw',
  'Cole Mine', 'Coral Reef', 'Count Mein', 'Crystal Ball', 'Crystal Clear',
  'Curtis See', 'Cy Clone', 'Cy Linder',
  // ── D ──
  'Dale Iver', 'Dan Druff', 'Dan Gerzone', 'Dan Safire', 'Dawn Keibals',
  'Dawn Treader', 'Dee Cember', 'Dee Hydrate', 'Dee Kay', 'Dee Liver',
  'Dee Scribe', 'Dee Tour', 'Dennis Tist', 'Dew Drop', 'Diane Ameter',
  'Dick Tionary', 'Dolly Pardon', 'Don Key', 'Doris Open', 'Doug Graves',
  'Drew Blood', 'Drew Peacock', 'Dusty Rhodes', 'Dusty Bin',
  // ── E ──
  'Earl Grey', 'Earl Lee Riser', 'Ed Ible', 'Ed Venture', 'Eddie Fied',
  'Eileen Dover', 'Eileen Right', 'Elaine Gale', 'Ellie Fant', 'Ellie Vator',
  'Emma Grate', 'Emma Rald', 'Eric Shun', 'Eva Porate', 'Evan Essence',
  'Eve N. Odds', 'Eve Ning',
  // ── F ──
  'Faith Fullness', 'Faye Kinnit', 'Faye Sbook', 'Ferris Wheeler', 'Flip Chart',
  'Flora Bunda', 'Flo Rida', 'Ford Focus', 'Forrest Fire', 'Forrest Green',
  'Frank Furter', 'Frank Incense', 'Frank Lee', 'Frank N. Stein', 'Fritz Cracker',
  // ── G ──
  'Gabe Locks', 'Gail Force', 'Gary Antee', 'Gene Pool', 'Gene Splice',
  'Gene Ius', 'Geri Atric', 'Gil T. Verdict', 'Ginger Ale', 'Ginger Snap',
  'Glen Dale', 'Gloria Steak', 'Grace Period', 'Grant Permission',
  // ── H ──
  'Hailey Storm', 'Hal F. Time', 'Hal Ibut', 'Hal O. Ween', 'Hans Down',
  'Hans Off', 'Harper Chord', 'Harry Leggs', 'Hazel Nut', 'Heath Row',
  'Helen Back', 'Helen Highwater', 'Herb Garden', 'Holly Day', 'Holly Wood',
  'Homer Work', 'Honor Roll', 'Hope Diamond', 'Hugo First', 'Hugo Wild',
  // ── I ──
  'I. P. Freely', 'Ida Know', 'Ilene Dover', 'Ima Hogg', 'Iris Stible',
  'Ivan Idea', 'Ivan Itchyback', 'Ivy League',
  // ── J ──
  'Jack Hammer', 'Jack Pot', 'Jack Rabbit', 'Jake Brake', 'Jan Itor',
  'Jay Bird', 'Jay Walker', 'Jean Pool', 'Jenna Ration', 'Jenna Side',
  'Jenny Tull', 'Jerry Can', 'Jerry Mander', 'Jerry Rigg', 'Jess Kidding',
  'Jim Nasium', 'Jo King', 'Joe King', 'John Quill', 'Joy Rider',
  'Joy Stick', 'Juan Moretime', 'Judy Cious', 'June Bug', 'Justin Case',
  'Justin Time',
  // ── K ──
  'Karen About', 'Kate Astrophe', 'Kay Oss', 'Kay Nine', 'Keith Board',
  'Kelly Green', 'Ken Do', 'Kenny Dewit', 'Kerry Oakey', 'Kitty Litter',
  'Klaus Trophobic', 'Kurt Reply', 'Kurt N. Call',
  // ── L ──
  'Lance Boyle', 'Laura Norder', 'Laurel Canyon', 'Lee King', 'Les Moore',
  'Les Ismore', 'Lily Pond', 'Lily Pad', 'Lisa Carr', 'Liv Wire',
  'Lloyd Back', 'Lou Briquet', 'Lou Natic', 'Lou Pole', 'Lucky Break',
  'Luke Warm',
  // ── M ──
  'Mac Aroni', 'Maddie Gascar', 'Major Problem', 'Mandy Tory', 'Marge Arine',
  'Marge Inall', 'Mark Down', 'Mark Etplace', 'Marshall Law', 'Matt Finish',
  'Matt Ress', 'Max Imize', 'Max Power', 'May Day', 'Mel Odious',
  'Mel Onhead', 'Miles Away', 'Miles Stone', 'Minnie Mize', 'Misty Morning',
  'Moe Mentum', 'Mona Lott', 'Morgan Guarantee', 'Myra Mains',
  // ── N ──
  'Nat Ural', 'Nat Urally', 'Neil Down', 'Nick Nack', "Nick O'Time",
  'Noah Fence', 'Noah Lott', 'Noah Way', 'Norm Alize', 'Norm Core',
  // ── O ──
  'Olive Branch', 'Olivia Twist', 'Omar Gosh', 'Opal Essence', 'Oscar Winner',
  'Otto Correct', 'Otto Mobile', 'Owen Money', 'Owen Nothing',
  // ── P ──
  'Paddy Field', 'Paddy Wagon', 'Paige Turner', 'Pat Ending', 'Pat Pending',
  'Pat Tern', 'Paul Bearer', 'Paul Ticks', 'Pauly Ester', 'Pearl Diver',
  'Penny Lane', 'Penny Wise', 'Perry Winkle', 'Pete Moss', 'Pete Zahut',
  'Phil Anthrope', 'Phil Harmonic', 'Phil Osophical', 'Phil Tering',
  'Portia Bella',
  // ── Q ──
  'Quinn Tessential', 'Quinn Tuplet',
  // ── R ──
  'Ray Beam', 'Ray Gunn', 'Ray N. Bow', 'Reed Allaboutit', 'Rich Quick',
  'Rick O. Shea', 'Rick Shaw', 'River Bank', 'Rob Banks', 'Robin Banks',
  'Robin Hood', 'Rock Bottom', 'Rocky Road', 'Rod Iron', 'Roger That',
  'Roman Holiday', 'Rose Bush', 'Russ Ling', 'Russell Sprout', 'Ruth Less',
  // ── S ──
  'Sage Advice', 'Sal Amander', 'Sam Ple', 'Sam Witch', 'Sandy Beach',
  'Sara Bellum', 'Scott Free', 'Sean Sheep', 'Shawn Delier', 'Shelby Late',
  'Skip Town', 'Sonny Day', 'Sonny Side', 'Sophie Sticated', 'Stan Dard',
  'Stan Still', 'Stella Performance', 'Sterling Silver', 'Stu Dent',
  'Stu Pendous', 'Sue Perior', 'Sue Shi', 'Summer Thyme',
  // ── T ──
  'Tab Ulate', 'Tamara Knight', 'Tara Misu', 'Ted E. Bear', 'Ted Talk',
  'Terry Bull', 'Terry Cloth', 'Tex Mex', 'Thyme Out', 'Tim Burr',
  'Tim Ber', 'Tom Ato', 'Tom Foolery', 'Tom Orrow', 'Tony Macaroni',
  'Travis Tea', 'Trent Setter', 'Tucker Out',
  // ── U ──
  'Uma Nother', 'Upton O\'Good', 'Uri Nate', 'Ursa Major',
  // ── V ──
  'Val Halla', 'Val Entine', 'Van Guard', 'Van Ish', 'Vera Cruz',
  'Vic Torious', 'Viola Solo', 'Virgil Ante',
  // ── W ──
  'Wade N. Pool', 'Walter Melon', 'Wanda Round', 'Warren Peace', 'Wayne Drop',
  'Wendy Blows', 'Wes Tern', 'Will Power', 'Willow Tree', 'Windy Day',
  'Woody Plant',
  // ── X Y Z ──
  'Xavier Breath', 'York Shire', 'Yul Brenner',
  'Zack Lee', 'Zelda Fitzgerald', 'Zoe Trope',
  // ── Bonus round ──
  'Art Vandelay', 'Bea Minor', 'Bea Sting', 'Bear Lee Awake', 'Candy Corn',
  'Clara Net', 'Clay Pigeon', 'Daisy Chain', 'Daisy Duke', 'Dan DeeLion',
  'Desiree Road', 'Eddie Toryal', 'Fergie Bout', 'Gus Toad', 'Gus Towind',
  'Hank Urchief', 'Heidi Claire', 'Hugo Boss', 'Ida Benn', 'Ima Pirate',
  'India Rubber', 'Jack O. Lantern', 'Jasmine Rice', 'Jean Jacket', 'Joe Matic',
  'Kat Nipp', 'Kaye Russ', 'Ken Tucky', 'Kirk Douglas', 'Lane Change',
  'Mabel Syrup', 'Mack Erel', 'Mandy Lifeboats', 'Marsha Mallow', 'Maya Buttreeks',
  'Misty Step', 'Mo Mentous', 'Nadia Satall', 'Neil B4Me', 'Olive Yew',
  'Ophelia Pain', 'Peg Legg', 'Polly Glot', 'Polly Unsaturated', 'Raul Model',
  'Reggie Stration', 'Rex Ington', 'Rosa Lind', 'Rosemary Thyme', 'Rusty Nail',
  'Sal Monella', 'Sandy Castles', 'Scarlett Fever', 'Shelly Beach', 'Sid Vicious',
  'Stella Artois', 'Summer Camp', 'Tab Collar', 'Tad Pole', 'Tess Tube',
  'Una Corn', 'Vince Elbow', 'Walt Zamboni', 'Ward Robe', 'Wilma Dickfit',
  'Yvonne Go', 'Zach Efron',
  // ── Extra spicy ──
  'Al Chemist', 'Alma Matter', 'Amber Gris', 'Annie Versary', 'Arturo Mato',
  'Barney Rubble', 'Belle End', 'Betty Crocker', 'Bill Yuns', 'Bjorn Free',
  'Blanche Carte', 'Brigitte Bardough', 'Bud Jet', 'Carmen Getit', 'Carter Blanche',
  'Chaz Mopolitan', 'Chester Drawers', 'Constance Noring', 'Darren Gitis', 'Dick Tater',
  'Dolly Madison', 'Earl Sandwich', 'Ed U. Cation', 'Ella Vation', 'Emmy Award',
  'Evelyn Tent', 'Faye Talattraction', 'Flip Side', 'Flora Fauna', 'Forbes List',
  'Frank Exchange', 'Gail Warning', 'Gladys Friday', 'Gwen Dolin', 'Halle Lujah',
  'Harbor Master', 'Heidi Ho', 'Heidi Seek', 'Honor System', 'India Jones',
  'Ivory Tower', 'Jan U. Ary', 'Jean Therapy', 'Jolly Roger', 'Kara Oke',
  'Kenny Loggins', 'Kit Chen', 'Lance A. Boyle', 'Lex Icon', 'Liberty Belle',
  'Lotta Nerve', 'Luke Out', 'Mack Daddy', 'Mary Poppins', 'May Flower',
  'Mel Practice', 'Mick Stape', 'Mike Stand', 'Mo Lasses', 'Mo Rocco',
  'Nat King Cole', 'Noel Edge', 'Otto Pilot', 'Oz Borne', 'Pat Down',
  'Pepe Rally', 'Phil Buster', 'Pierce Brosnan', 'Poppy Seed', 'Ray Zing',
  'Rhett Conning', 'Rocky Balboa', 'Rose Colored', 'Rush Hour', 'Sandy Storm',
  'Saul Goodman', 'Skip Trace', 'Smokey Robinson', 'Sol Stice', 'Spin Doctor',
  'Stan Offish', 'Star Gazer', 'Sterling Archer', 'Storm Chaser', 'Ted Mosby',
  'Tess Tickle', 'Tim E. Bomb', 'Todd Ler', 'Vic Timless', 'Wanda Vision',
  'Ward Cleaver', 'Wynne Dixie', 'Zane Grey', 'Zeke End',
]

// ────────────────────────────────────────────
// CORPORATE LINGO  (~150)
// ────────────────────────────────────────────

const CORPORATE = [
  // Pun names from corporate terms
  'Aggie Methodology', 'Al Gorithm', 'Al Ignment', 'Ann Alytics', 'Art Ificial',
  'Ben Chmark', 'Bill Able', 'Bill Cycle', 'Brand Awareness', 'Bud Jet Approval',
  'Cal Ibrate', 'Cap Expenditure', 'Chad Stakeholder', 'Claire Ification', 'Cole Laborate',
  'Con Sultant', 'Core Competency', 'Dan Shboard', 'Dawn Sizing', 'Dee Ployment',
  'Dee Scoping', 'Del Iverable', 'Doug Iligence', 'Drew Pipeline', 'Ed Scalation',
  'Eva Luate', 'Faye Sibility', 'Flo Chart', 'Grant Funded', 'Grant Proposal',
  // KPI & metrics themed
  'Hugh Throughput', 'Jay Son Schema', 'Kay P. Eye', 'Lee Dership', 'Marge In',
  'Mark Etfit', 'Mark Etshare', 'Max Bandwidth', 'Max Capacity', 'Mel Iorate',
  'Miles Tone', 'Mo Netize', 'Noah Scope', 'Norm Ative', 'Olivia Board',
  // Strategy & planning
  'Opti Mize', 'Pat Hfinder', 'Perry Formance', 'Pete Erprinciple', 'Phil Anthropy',
  'Pilar Strategy', 'Quinn Terly', 'Ray Venue', 'Rhoda Map', 'Rob Ustness',
  'Ross Terfall', 'Sara Nity', 'Scal Ability', 'Skip Level', 'Stacy Holder',
  // Meeting culture
  'Stan Dup', 'Sue Stainability', 'Sy Nergy', 'Tab Leaux', 'Tim Eline',
  'Val Uation', 'Van Tagepoint', 'Vision Ary', 'Wendy Gets Backto', 'Wynne Win',
  // Corporate archetypes
  'Big Picture Barb', 'Blue Sky Brian', 'Bottom Line Bob', 'Bowtie Brad', 'Circle Back Cindy',
  'Cross Functional Craig', 'Data Driven Dana', 'Deep Dive Doug', 'Disruptor Dave', 'Elevator Pitch Ed',
  'Growth Hacker Greg', 'Holistic Hannah', 'Incentivize Irene', 'Iterate Ivan', 'Jargon Janet',
  'Lean Startup Lisa', 'Leverage Larry', 'Monetize Morgan', 'Move The Needle Nancy', 'Next Level Nate',
  'Ops Excellence Olivia', 'Paradigm Shift Paul', 'Pivot Patterson', 'Platform Pete', 'Proactive Priya',
  'Quarter Over Quarter Quinn', 'Restructure Rachel', 'Revenue Rita', 'Rock Star Rick', 'Runway Ruth',
  'Scalable Sam', 'Sprint Sabrina', 'Stakeholder Steve', 'Strategic Stefan', 'Synergy Sandra',
  'Thought Leader Theo', 'Touch Base Tony', 'Upskill Uma', 'Value Add Vince', 'Vertical Vera',
  'Waterfall Walter', 'Win-Win Wendy',
  // Corporate lingo as names
  'Action Item Annie', 'Bandwidth Bill', 'Blocker Betty', 'Burn Rate Bart', 'Cadence Carl',
  'Churn Rate Charlie', 'CTO Chad', 'Due Diligence Dina', 'Exit Strategy Erica', 'Fiscal Year Fiona',
  'Greenfield Gary', 'IPO Ingrid', 'Low Hanging Fruit', 'OKR Oscar', 'Ping Me Patty',
  'Power Point Pam', 'Retro Spective', 'Silo Buster Sue', 'Standup Stacy', 'Sunset Sophie',
  'Take Offline Tina', 'Town Hall Tom', 'Unicorn Ursula', 'War Room Wes', 'Zero Sum Zara',
  // Bonus corporate
  'Align The Stars Al', 'Boil The Ocean Bea', 'Buy-In Boris', 'Change Agent Chip', 'Deck Builder Derek',
  'Drill Down Donna', 'Full Stack Frank', 'Headcount Helen', 'Impact Ian', 'Journey Map Jade',
  'Kanban Karen', 'MVP Martha', 'Net New Nick', 'On Brand Omar', 'Pipeline Pedro',
  'Quick Win Quentin', 'Roadmap Rosa', 'Scope Creep Stan', 'Sprint Zero Steph', 'T-Shaped Tina',
  'Unblock Uma', 'Velocity Val', 'Whiteboard Wally', 'Yield Yolanda',
]

// ────────────────────────────────────────────
// DEV JOKES  (~150)
// ────────────────────────────────────────────

const DEV = [
  // Language & tool puns
  'Ada Compiler', 'Ajax McRequest', 'Ana Parse', 'Array McFlatmap', 'Bash Profile',
  'Ben Chpress', 'Bit Bucket', 'Bit Flipper', 'Boo Lean', 'Bran Ching',
  'Bug Hunter', 'Byte Me', 'Cache Money', 'Cal Lstack', 'Cara T. Return',
  'Chuck Norris Exception', 'Clo Sure', 'Con Sole Log', 'Con Tainer', 'Cookie Monster',
  'Core Dump', 'Curl Request', 'Cy Bernetic',
  // Error & debug themed
  'Dan Gling Pointer', 'Dee Bug', 'Dee Kompiler', 'Dev Null', 'Docker Phil',
  'Doug Kerize', 'Dry Run', 'Ed Itor Wars',
  'Elle Ment Node', 'Err Handler', 'Eva L. Expression', 'Exception Eddie',
  // Framework puns
  'Faye Lure Mode', 'Foo Barrington', 'Fork Bomb', 'Fred Thread',
  'Gabby Collector', 'Git Blame', 'Git Committed', 'Git Push Force', 'Grace Hopper Jr',
  // Infrastructure
  'Hash Map Harry', 'Heap Overflow', 'Heather Sync', 'Hot Fix Hank', 'Hugh Request',
  'Hugo Server', 'Ida Pending',
  // Classic CS names
  'Index Outofbounds', 'Inf Loop', 'Int Erface', 'Ivy Dependency',
  'Jack Script', 'Jan Go Template', 'Java Scripter', 'Jen Kins', 'JSON Derulo',
  // K-N
  'Kay Bash', 'Ken Tainer', 'Kern El Panic', 'Kit Bash',
  'Lambda Linda', 'Lara Val', 'Lee Nux', 'Lint Error', 'Lisa Compiler',
  'Logger McLogface', 'Loop Invariant', 'Luce Coupling',
  'Mac Ro', 'Mal Ware', 'Mark Down', 'Meg Abyte', 'Merge Conflicta',
  'Meta Data', 'Mikro Service', 'Mocha Test',
  'Nano Server', 'Neil Assembly', 'Nil Pointer', 'Noah Package', 'Node Module',
  'Norm Alize', 'Null Pointer',
  // O-R
  'Off Byone', 'Otto Scale',
  'Patch Tuesday', 'Pearl Script', 'Pete Thon', 'Phil Ament', 'Ping Timeout',
  'Pip Install', 'Pixel Pete', 'Polly Morph', 'Pop Stack', 'Proxy Patterson',
  'Query Selector', 'Queue Overflow',
  'Ray Dis', 'React Ionary', 'Rebase Rita', 'Recursive Rex',
  'Redis Cash', 'Reg X. Pattern', 'Rick Ursion', 'Rob O. Cop', 'Root Access',
  'Ruby Gemstone', 'Russ T. Pipeline', 'Ruth Refactor',
  // S-T
  'Sam Verize', 'Sara Lize', 'Seg Faulter', 'Sem Aphore', 'Shell Scriptson',
  'Sir Kibreaker', 'Skip Ittest', 'Sophie Schema', 'SQL Bobby Tables', 'Stan Dalone',
  'String Builder', 'Stu Bclass', 'Sue Docode', 'Sudo Nimh', 'Sy Slog',
  'Tab Spacington', 'Ted Ious Code', 'Tex Editor', 'Tim Eout', 'Tom Cat Server',
  'Trent Action', 'Ty Pescript',
  // U-Z
  'Una Sync', 'Uni Code', 'Uri Builder',
  'Val Idator', 'Van Illa JS', 'Vec Torize', 'Vi Emacs', 'Vue Template',
  'Web Socket Wendy', 'Webpack Wally', 'Will Deploy',
  'Xavier Ception', 'Yarn Install',
  'Zach T. Typed', 'Zero Day', 'Zip Archive',
  // Bonus dev
  'Async Andy', 'Await Amanda', 'Binary Bob', 'Boolean Betty',
  'Callback Carl', 'Chmod Charlie', 'Cron Job Joe', 'Daemon Dave',
  'Elastic Elena', 'Firewall Fiona', 'Garbage Collector Gary', 'Heroku Hero',
  'Idempotent Ian', 'Kubectl Kate', 'Localhost Larry', 'Mutex Max',
  'Nginx Nancy', 'OAuth Oscar', 'Postgres Pete', 'Redis Rose',
  'Schema Steve', 'Terraform Tina', 'Ubuntu Uma', 'Verbose Vince',
  'Webhook Walt', 'YAML Yolanda', 'Zombie Process Zach',
]

// ────────────────────────────────────────────
// OPS CODENAMES  (~120)
// ────────────────────────────────────────────

const OPS = [
  // Classic two-word codenames
  'Crimson Falcon', 'Shadow Viper', 'Iron Tempest', 'Silent Thunder', 'Arctic Fox',
  'Phantom Eagle', 'Cobalt Strike', 'Steel Horizon', 'Jade Dragon', 'Neon Ghost',
  'Black Orchid', 'Velvet Storm', 'Copper Wolf', 'Obsidian Raven', 'Silver Cascade',
  'Amber Spectre', 'Onyx Talon', 'Scarlet Arrow', 'Titanium Owl', 'Azure Phoenix',
  'Granite Serpent', 'Indigo Hammer', 'Ember Rift', 'Ivory Dagger', 'Midnight Lynx',
  'Ruby Sentinel', 'Sapphire Bolt', 'Carbon Whisper', 'Dusk Raptor', 'Frost Mantis',
  'Gilded Sphinx', 'Hollow Point', 'Lunar Eclipse', 'Marble Fang', 'Nebula Drift',
  'Ochre Cyclone', 'Pearl Venom', 'Quicksilver Ghost', 'Rust Beacon', 'Slate Phantom',
  // Nature + danger
  'Thorn Cascade', 'Umbra Strike', 'Vapor Trail', 'Wildfire Echo', 'Zenith Blade',
  'Acid Rain', 'Blaze Runner', 'Cold Fusion', 'Dark Matter', 'Eclipse Alpha',
  'Fallen Star', 'Grave Shift', 'Hollow Sun', 'Iron Curtain', 'Jet Stream',
  'Kill Switch', 'Lone Wolf', 'Mach Five', 'Night Shade', 'Omega Dawn',
  'Prism Break', 'Quantum Leap', 'Red Herring', 'Storm Front', 'Timber Wolf',
  // Military style
  'Alpha Bravo', 'Bravo Zulu', 'Charlie Foxtrot', 'Delta Force', 'Echo Tango',
  'Foxtrot Lima', 'Golf Sierra', 'Hotel November', 'India Juliet', 'Kilo Oscar',
  'Lima Papa', 'Mike Quebec', 'November Romeo', 'Oscar Sierra', 'Papa Tango',
  'Romeo Whiskey', 'Sierra Victor', 'Tango Uniform', 'Uniform X-Ray', 'Victor Yankee',
  // Tech ops
  'Binary Dawn', 'Chrome Dome', 'Cipher Lock', 'Data Storm', 'Flux Rider',
  'Ghost Protocol', 'Grid Lock', 'Hash Core', 'Ion Storm', 'Laser Wire',
  'Matrix Zero', 'Neon Blade', 'Orbit Decay', 'Pulse Wave', 'Signal Fire',
  'Stealth Mode', 'Surge Protector', 'Terminal Velocity', 'Vault Keeper', 'Zero Hour',
]

// ────────────────────────────────────────────
// HEIST CREW  (~120)
// ────────────────────────────────────────────

const HEIST = [
  // Classic roles
  'The Mastermind', 'The Wheelman', 'The Hacker', 'The Cleaner', 'The Fixer',
  'The Lookout', 'The Safecracker', 'The Inside Man', 'The Closer', 'The Brains',
  'The Muscle', 'The Fence', 'The Getaway', 'The Diversion', 'The Ghost',
  'The Forger', 'The Con Artist', 'The Pickpocket', 'The Chameleon', 'The Watcher',
  'The Architect', 'The Bankroller', 'The Handler', 'The Sweeper', 'The Mole',
  'The Veteran', 'The Rookie', 'The Wildcard', 'The Professional', 'The Natural',
  // Persona names
  'Slick Vinnie', 'Fast Eddie', 'Lucky Luca', 'Smooth Tony', 'Jazz Hands Jenny',
  'Three Card Monte', 'Knuckles McGee', 'Baby Face Nelson', 'Fingers Malone', 'Silky Sullivan',
  'Doc Holiday', 'Slim Pickins', 'Sly Cooper', 'Two Tone Tony', 'Diamond Dallas',
  'Goldfinger', 'Silver Tongue', 'Velvet Vic', 'Brass Tacks', 'Iron Mike',
  'Copper Top', 'Steel Magnolia', 'Chrome Dome', 'Platinum Pat', 'Neon Nicky',
  'Shadow', 'Ace', 'Blitz', 'Cipher', 'Dagger',
  'Eclipse', 'Falcon', 'Gambit', 'Havoc', 'Jinx',
  'Karma', 'Lynx', 'Mirage', 'Nova', 'Onyx',
  'Phoenix', 'Quickdraw', 'Rogue', 'Spectre', 'Tempest',
  // Job-specific
  'The Demolition Man', 'The Tunnel Rat', 'The Wire Tapper', 'The Bagman', 'The Croupier',
  'The Escape Artist', 'The Grifter', 'The Juggler', 'The Magician', 'The Negotiator',
  'The Operator', 'The Planner', 'The Surgeon', 'The Technician', 'The Virtuoso',
  // Heist movie inspired
  'Danny Ocean', 'Mr. Pink', 'Mr. White', 'Mr. Orange', 'Mr. Blonde',
  'The Italian Job', 'The Professor', 'Berlin', 'Tokyo', 'Nairobi',
  'Helsinki', 'Denver', 'Moscow', 'Rio', 'Bogota',
  'Manila', 'Palermo', 'Marseille', 'Stockholm', 'Lisbon',
  // Underground
  'Alias Unknown', 'Black Market Bob', 'Contraband Clara', 'Dead Drop Derek', 'Encrypted Emma',
  'Fugitive Frank', 'Greyhat Gary', 'Hot Wire Hannah', 'Incognito Ivan', 'Jailbreak Jake',
]

// ────────────────────────────────────────────
// CELEBRITY PUNS  (~120)
// ────────────────────────────────────────────

const CELEB = [
  // Movie stars
  'Bread Pitt', 'Leonardo DiCappuccino', 'Meryl Sweep', 'Tom Hanks A Lot', 'Johnny Depth',
  'Keanu Leaves', 'Sandra Bullocks', 'Will Smithereens', 'Morgan Freemason', 'Matt Daymon',
  'Angelina Jolie Rancher', 'Al Pacino Peppers', 'Robert Downtime Jr', 'Chris Prattfall', 'Scarlett Johandsome',
  'Dwayne The Rock JSON', 'Vin Diesel Fuel', 'Nicolas Cage Match', 'Jackie Chandelier', 'Sylvester Stallionaire',
  'Harrison Fjord', 'Bruce Willingness', 'Samuel L. Hackson', 'Ryan Goosling', 'Emma Stonecold',
  'Benedict Cucumberbatch', 'Cate Blanchett Check', 'Hugh Jackedman', 'Natalie Portmanteau', 'Jeff Goldbloom',
  // Musicians
  'Ariana Grandma', 'Billie Eyelash', 'Drake Equation', 'Ed Sheer Force', 'Elvis Parsley',
  'Freddy Mercurial', 'Justin Timberlake Effect', 'Lady Grandma', 'Mick Jaguar', 'Ozzy Osbourne Identity',
  'Post Malone Wolf', 'Snoop Debugger', 'Taylor Swiftkey', 'Kanye Quest', 'Beyonce Knowles-it-all',
  'Bruno Mars Bar', 'Cardi B. Careful', 'Dolly Partition', 'Elton Johnathan', 'Frank Sinatra Copy',
  'John Lemon', 'Katy Peregrine', 'Lizzo Compiler', 'Madonna Debug', 'Rihanna Restart',
  'Stevie Wonderful', 'Whitney Housecleaner', 'Bob Marley Malware',
  // Tech moguls
  'Elon Must', 'Jeff Bezos-erk', 'Bill Gates Open', 'Mark Zucchiniberg', 'Steve Jobless',
  'Tim Crook', 'Larry Paycheck', 'Satya Nutella', 'Sundar Pichairman', 'Jensen Huangover',
  // TV & comedy
  'Jerry Signfield', 'Oprah Windfury', 'Ellen DeGenerous', 'Conan O\'Brian Damage',
  'Jimmy Fallout', 'Seth Rogaine', 'Tina Feyline', 'Amy Poehler Bear', 'Dave Chapstick',
  'Adam Sandcastle', 'Jim Carrot', 'Robin Williamsburg', 'Ben Stillerlife', 'Melissa McCartney',
  'Will Ferrealtor', 'Steve Carello', 'John Olivegrarden', 'Aubrey Plazma', 'Chris Rocket',
  // Historical/science
  'Albert Einsteiner', 'Isaac Newtron', 'Marie Curiouser', 'Charles Darthwin', 'Nikola Teslatruck',
  'Stephen Hawkward', 'Ada Loveletter', 'Alan Touring', 'Grace Hoppscotch', 'Linus Torvaldstruction',
  // Athletes
  'Michael Jordanache', 'LeBron Jamestown', 'Serena Williamsburg', 'Lionel Messy', 'Tiger Woodwork',
  'David Peckham', 'Tom Bradykins', 'Muhammad Olive', 'Usain Bolted', 'Simone Bilestown',
  // Bonus
  'Quentin Tarantinope', 'Martin Scorseasy', 'Stanley Kubrickhouse', 'James Cameronald',
  'Wes Andersonburg', 'Tim Burntonsil', 'Ridley Scottfree', 'Christopher No-plan',
  'Guillermo Del Toroidal', 'Alfred Hitchcocktail',
]

// ────────────────────────────────────────────
// Theme map + random picker
// ────────────────────────────────────────────

const THEME_MAP: Record<NamingTheme, readonly string[]> = {
  fruits: FRUITS,
  rpg: RPG,
  wow: WOW,
  memes: MEMES,
  corporate: CORPORATE,
  dev: DEV,
  ops: OPS,
  heist: HEIST,
  celeb: CELEB,
}

export function randomName(themes: NamingTheme | NamingTheme[] = ['memes']): string {
  const themeList = Array.isArray(themes) ? themes : [themes]
  const pool = themeList.flatMap(t => THEME_MAP[t] ?? [])
  if (pool.length === 0) return MEMES[Math.floor(Math.random() * MEMES.length)]
  return pool[Math.floor(Math.random() * pool.length)]
}
