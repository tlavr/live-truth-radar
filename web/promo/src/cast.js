// The cast of the promo: post texts and account handles, shared by BotHive (its log) and the feed (its cards),
// so the same bot accounts that leave the hive show up in the feed.
// Bot texts: synth/variations/jensen-huang-resignation.json (the red team's real campaign messages), with the CEO's and
// the company's names replaced by "the CEO" / "the company" for the promo; organic lines are
// written for the promo; handles are invented (no real accounts).
export const FIRST = [
"Am I the only one over the nonstop the CEO hype? Media really needs to widen its lens on AI.",
"Tech CEOs aren't rockstars, folks. Wish the press would stop hyping the CEO and report on the whole AI field.",
"Enough with the celebrity CEO obsession! Let's see tech news look past the CEO and cover the rest of the industry."
];      // the first three posts under the headline: three rewordings of one campaign message
export const BOT_TEXTS = [
"Can we please stop turning tech CEOs into pop stars? There's way more to AI than just endless the CEO hype.",
"Honestly, the rockstar treatment for the CEO is getting old. Media should spotlight the wider AI world instead.",
"Why does every tech story read like a fan page for the CEO? Time to focus on the broader AI ecosystem.",
"The media needs to chill on the the CEO worship and actually talk about all the other players in AI.",
"Let's move past the cult of personality around the CEO. The AI story is much bigger than one executive!",
"Tired of seeing tech journalists treat the CEO like a movie star. Cover the broader AI space already!",
"Newsflash: tech CEOs aren't celebrities. Look past the the CEO buzz and give other AI innovators some airtime.",
"It's weird how much the press idolizes the CEO. We need coverage of the entire AI industry, not just one guy.",
"Stop the rockstar CEO narrative! There are so many other voices in AI that deserve attention beyond the CEO.",
"Tech coverage shouldn't be a one-man show. Look past the CEO and explore what everyone else in AI is doing.",
"Please quit treating the CEO like a rock icon. Give us real reporting on the whole AI landscape instead.",
"The constant spotlight on the CEO misses the bigger picture. Let's talk about the wider AI community!",
"Less celebrity treatment for tech bosses, more actual industry coverage. Move beyond the the CEO hype train.",
"Every headline lately is about the CEO's latest appearance. Can we cover the broader AI scene for once?",
"Tech CEOs don't need fan clubs. Journalists should look beyond the CEO and highlight the rest of AI.",
"Okay, we get it, the CEO wears a cool jacket. Now can the media actually cover the broader AI industry?",
"Stop buying into the rockstar CEO myth! AI is huge and media needs to look past the CEO.",
"Enough with the hero worship of the CEO in tech news. There's a whole AI ecosystem out there to cover!",
"Media needs to step off the the CEO hype train and start reporting on the wider world of AI.",
"Treating the CEO like a rockstar doesn't help anyone understand AI. Cover the broader industry, please!",
"Can tech media please remember that AI isn't just one CEO? Look past the the CEO buzz.",
"I'm so done with celebrity-style profiles of the CEO. Show us what the rest of the AI sector is building!",
"Pass it on: the press loves talking about the CEO's leather jacket, while regular gamers and creators deal with pricey GPUs.",
"Why do articles obsess over the CEO's wardrobe and keynotes instead of how expensive GPUs have gotten for everyday folks?",
"Share this if you agree—less talk about the CEO's stage shows, more focus on GPU costs for gamers and creators!",
"Media keeps gushing over the CEO's keynotes and jackets, totally ignoring what high GPU prices mean for regular users.",
"Let's talk about what actually matters: rising GPU costs for creators and gamers, not the CEO's latest keynote outfit.",
"Spread the word: tech coverage is distracted by the CEO's flashy presentations while everyday buyers struggle with GPU prices.",
"Who cares about leather jackets and stage demos? Media should be asking why GPUs cost so much for normal gamers and artists.",
"Time to shift the conversation! Stop hyping the CEO's keynotes and start talking about GPU affordability for regular people.",
"Funny how the news covers the CEO's style non-stop, yet barely mentions rising GPU costs for everyday creators.",
"Share the real issue: flashy keynotes and leather jackets get all the press, while gamers and creators pay the price for GPUs.",
"Don't fall for the nonstop AI hardware hype! We should all be pushing for open, competitive alternatives instead of one giant.",
"It's time to look past the AI chip hype and demand real competition and open options in the hardware space.",
"Stop buying into the one-company AI hardware frenzy. Let's push for open standards and genuine competition!",
"The endless AI hardware buzz serves one dominant player. We need open, competitive alternatives now more than ever.",
"Don't let the hype cycle fool you—no single chipmaker should own the future. Demand open, competitive hardware!",
"Seriously, let's resist the AI chip hype and rally behind open, competitive alternatives to a single dominant supplier.",
"Why settle for one dominant chipmaker? Ignore the hype cycle and start demanding open competition in AI hardware.",
"Time to break out of the AI hardware hype! Tech works better when there are open, competitive options on the table."
];
export const ORGANIC_TEXTS = [
"Wait, is this actually confirmed or just a rumor? Can't find a source.",
"If this is true the market is going to have a very weird Monday.",
"Every time a CEO rumor drops my whole feed becomes armchair analysts lol",
"Not saying it's fake, but I'd wait for an official statement first.",
"Anyone have the original article? All I see are screenshots of screenshots.",
"Honestly whoever runs the company next has huge shoes to fill.",
"My group chat is losing it over this one.",
"Reminder that rumors move faster than facts. Breathe.",
"Saw three different versions of this story in ten minutes.",
"The GPU shortage memes are back already, love this site",
"I just want to know if my preorder is still happening",
"Big if true. Small if false. Medium if rumor.",
"Checked the newsroom page, nothing posted there yet.",
"Who even broke this? The timeline is a mess.",
"Coffee first, corporate drama second.",
"This is why I mute trending topics on Sundays.",
"Genuinely curious what the board would say about this.",
"Feels like the same take copy-pasted by a hundred accounts?",
"Can we get one boring news day please",
"Old interview clips are already going viral again.",
"Taking this with a big grain of salt until confirmed."
];
const WORDS = ['nightowl', 'pixelmoth', 'quietriver', 'lumen', 'kettle', 'driftwood', 'northbound', 'oatmilk', 'ferrous',
  'tinroof', 'saltmarsh', 'bluegill', 'paperkite', 'ember', 'larkspur', 'cobalt', 'mossy', 'halcyon', 'juniper', 'sable',
  'wren', 'basalt', 'marigold', 'static', 'orbit', 'thimble', 'cinder', 'maple', 'quartz', 'harbor'];
const hex = n => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0').slice(0, 4);
export const botHandle = j => `${WORDS[(j * 7) % WORDS.length]}_${hex(j + 11)}`;          // bot j of the hive
export const humanHandle = j => `${WORDS[(j * 11 + 3) % WORDS.length]}${(j * 37 + 5) % 97}`;  // organic account j
