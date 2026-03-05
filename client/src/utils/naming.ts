export type NamingTheme = 'fruits' | 'rpg' | 'wow' | 'memes'

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

const MEMES = [
  'Chris P. Bacon', 'Paige Turner', 'Anita Bath', 'Justin Time', 'Barry Cade',
  'Al O. Vera', 'Brock Lee', 'Phil Harmonic', 'Sue Shi', 'Rick O. Shea',
  'Warren Peace', 'Anne Chovey', 'Barb Arian', 'Buck Wheat', 'Candi Barr',
  'Doug Graves', 'Earl Lee Riser', 'Faye Kinnit', 'Gene Pool', 'Holly Wood',
  'I. P. Freely', 'Jack Pot', 'Kay Oss', 'Lou Pole', 'Moe Mentum',
  "Nick O'Time", 'Olive Branch', 'Pat Pending', 'Quinn Tessential', 'Robin Banks',
  'Stan Dard', 'Terry Bull', 'Uma Nother', 'Vic Torious', 'Will Power',
  'Xavier Breath', 'Yul Brenner', 'Zack Lee', 'Al Pha', 'Ben Dover',
  'Carl Ache', 'Dawn Keibals', 'Ellie Fant', 'Frank N. Stein', 'Gail Force',
  'Hal O. Ween', 'Iris Stible', 'Jay Walker', 'Kurt Reply', 'Laura Norder',
]

export function randomName(theme: NamingTheme = 'fruits'): string {
  const pool = theme === 'rpg' ? RPG
    : theme === 'wow' ? WOW
    : theme === 'memes' ? MEMES
    : FRUITS
  return pool[Math.floor(Math.random() * pool.length)]
}
