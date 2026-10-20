// Any CSV a recruiter has is read right, whatever its headers say — the
// shapes here are the ones real lists come in (made-up people only):
//   - First, Last, City, State, Zip, Email, Contact: the place put together
//     ("Fort Worth, TX 76107"), "Contact" read as the phone it holds
//   - a header row with a stray phone number in it, and trailing spaces
//   - no header over the name column, a "State" column holding "City, ST"
//     (or a phone number, or "?"), unlabeled recruiter and comment columns
//   - a header split over two rows, two addresses in one cell, ", Jr."
//   - spare columns of sparse notes; names in capitals, with digits glued
//     on, or "Unknown"; HTML codes and look-alike hyphens; "?" and "NA"
//   - Outlook, HubSpot, a semicolon file in French, and a file with no
//     header at all
//   - a Wholesale Payments address: never added
// Nothing is sent.
const { startApp, ok, done, crash } = require('./helpers');

(async () => {
  const s = await startApp({ offset: 294 });
  // A file read, mapped and imported as the Import page does it.
  const importFile = async (text) => {
    const read = await s.json('POST', '/api/import/csv', { text, via: 'csv' });
    if (read.status !== 200) return { read };
    const { rows, lines, mapping, headerless, headers } = read.body;
    const pre = await s.json('POST', '/api/import/preview', { rows, lines, mapping, headerless });
    const before = (await s.store.load()).candidates.length;
    const commit = await s.json('POST', '/api/import/commit', { rows, lines, mapping, headerless, source: 'csv' });
    const added = (await s.store.load()).candidates.slice(before);
    const by = (email) => added.find((c) => c.email.toLowerCase() === email.toLowerCase());
    const named = Object.fromEntries(Object.entries(mapping).filter(([, v]) => v >= 0).map(([k, v]) => [k, headers[v]]));
    return { read: read.body, pre: pre.body, commit: commit.body, added, by, named };
  };
  try {
    // ---- First, Last, City, State, Zip, email, Contact ----
    let r = await importFile([
      'First,Last,City,State,Zip,email,Contact',
      'Avery,Sample,Fort Worth,TX,76107,avery.sample@example.com,469-555-2101',
      'BLAKE,EXAMPLER,Marietta,GA,30008,blake.exampler@example.com,404-555-2102',
      'Casey4417,Madeup,Poteau,OK,74953,casey.madeup@example.com,539&#8208;555&#8208;2103',
      'Unknown,Unknown,Richmond,VA,23219,unknown.person@example.com,804-555-2104',
      'Dana,Fictional,Buffalo,NY,,dana.fictional@example.com,?',
    ].join('\n'));
    ok(r.named.city === 'City' && r.named.state === 'State' && r.named.zip === 'Zip' && r.named.phone === 'Contact' && r.named.firstName === 'First', 'First/Last/City/State/Zip/email/Contact: every column found', r.named);
    let c = r.by('avery.sample@example.com');
    ok(c && c.location === 'Fort Worth, TX 76107' && c.phone === '+14695552101' && c.name === 'Avery Sample', 'the place is put together, the phone kept one way', c && [c.location, c.phone, c.name]);
    ok(r.by('blake.exampler@example.com').name === 'Blake Exampler', 'a name in capitals is written the way names are', r.by('blake.exampler@example.com').name);
    c = r.by('casey.madeup@example.com');
    ok(c.firstName === 'Casey' && c.phone === '+15395552103', 'digits glued onto a name are dropped; HTML hyphen codes in a number are read', [c.firstName, c.phone]);
    ok(r.by('unknown.person@example.com').name === '' && r.by('dana.fictional@example.com').phone === '' && r.by('dana.fictional@example.com').location === 'Buffalo, NY', '"Unknown" is no name and "?" no number; a place without a ZIP is still a place');

    // ---- a stray phone number in the header row, and spare columns ----
    r = await importFile([
      'First,Last,City,State,Zip,Email,Contact ,8065552199,,',
      'Erin,Testcase,Wayne,MI,48184,erin.testcase@example.com,734-555-2105,start here 3/3,,',
      'Finn,Placeholder,Kissimmee,FL,34741,finn.placeholder@example.com,407-555-2106,,,',
      'Gale,Specimen,Pueblo,CO,81001,gale.specimen@example.com,719-555-2107,,,',
      'Hana,Mockup,Houston,TX,77002,hana.mockup@example.com,281-555-2108,,,',
    ].join('\n'));
    ok(r.read.headerless === false && r.named.email === 'Email' && r.named.firstName === 'First' && r.named.city === 'City', 'a stray number in the header row: still the header', r.named);
    ok(r.commit.added === 4 && !r.added.some((x) => /email/i.test(x.email)), 'and not a row of data', r.commit);
    ok(r.by('erin.testcase@example.com').notes === 'start here 3/3' && r.by('erin.testcase@example.com').name === 'Erin Testcase', 'a spare column\'s notes are kept as notes');

    // ---- no header over the names; a "State" column of "City, ST" ----
    r = await importFile([
      ' ,State,Email,Contact,,',
      'Ivy Exampleton,8475552109,ivy.exampleton@example.com,8475552109,,',
      'Jon Sampleby, IL,jon.sampleby@example.com,847.555.2110,,',
      'Kim Fakerson,?,kim.fakerson@example.com,678.555.2111,,',
      'Lee Madeupson,"Abingdon, MD",lee.madeupson@example.com,443-555-2112,,',
      'Max Testerly,"Austin, TX",max.testerly@example.com, 806-555-2113,Bobby,Doesnt like vesting',
      'Nia Dummyton,"Austin, TX",nia.dummyton@example.com,NA,Lane,',
      'Ola Pretendo,"Chicago, IL",ola.pretendo@example.com,(312) 555-2114,,',
      'Pat Fauxman,"Denver, CO", pat.fauxman@example.com ,720-555-2115,,',
      'Pat Fauxman,"Denver, CO",pat.fauxman@example.com,720-555-2115,,',
      'Quinn Imaginary,"Tucson, AZ",quinn.imaginary@example.com,520-555-2116,,',
      'Rae Inventa,"Phoenix, AZ",rae.inventa@example.com,602-555-2117,,',
    ].join('\n'));
    ok(r.named.name === 'Column 1' && r.named.location === 'State' && r.named.phone === 'Contact', 'no header over the names: recognised as the names, not the company', r.named);
    ok(r.added.every((x) => x.name && !x.company), 'everyone has their name, and nobody a company of names', r.added.filter((x) => !x.name || x.company).map((x) => x.email));
    ok(r.by('max.testerly@example.com').notes === 'Bobby · Doesnt like vesting', 'the two unlabeled columns are notes, both kept', r.by('max.testerly@example.com').notes);
    ok(r.by('ivy.exampleton@example.com').location === '' && r.by('kim.fakerson@example.com').location === '' && r.by('lee.madeupson@example.com').location === 'Abingdon, MD', 'a phone number or "?" in the place column is no place', [r.by('ivy.exampleton@example.com').location, r.by('kim.fakerson@example.com').location]);
    ok(r.by('nia.dummyton@example.com').phone === '' && r.by('pat.fauxman@example.com') && r.pre.duplicate === 1, '"NA" is no number; spaces around an address do not matter; a repeat is one person', r.pre);

    // ---- a header split over two rows; two addresses in a cell ----
    r = await importFile([
      ',PartnerPrimary.Phone,,Notes',
      'Partner Name,,PartnerPrimary.PrimaryEmail,',
      'Sam Specimen,(281) 555-2118,sam.specimen@example.com,Number disconnected',
      'Tess Exemplar,(281) 555-2119,tess.exemplar@example.com;tess.work@example.org,Called and text',
      '"Uma Mockery, Jr.",(713) 555-2120,uma.mockery@example.com,',
      '"Vic ""Vee"" Sampler",(713) 555-2121,vic.sampler@example.com,',
      'Wren Nomail,(713) 555-2122,,',
      'Xan Tollfree,(866) 555-2123,xan.tollfree@example.com,',
      'Pia Firstrow,(281) 555-2136,pia.firstrow@example.com;quin.secondrow@example.com,',
      'Quin Secondrow,(281) 555-2137,quin.secondrow@example.com,',
    ].join('\n'));
    ok(r.read.headers.join('|') === 'Partner Name|PartnerPrimary.Phone|PartnerPrimary.PrimaryEmail|Notes' && r.read.rows.length === 8, 'a header split over two rows is one header', r.read.headers);
    ok(r.named.name === 'Partner Name' && r.named.email === 'PartnerPrimary.PrimaryEmail' && r.named.phone === 'PartnerPrimary.Phone' && r.named.notes === 'Notes', 'and every column is found by it', r.named);
    c = r.by('tess.exemplar@example.com');
    ok(c && JSON.stringify(c.altEmails) === JSON.stringify(['tess.work@example.org']), 'two addresses in one cell: the first to write to, the second kept as theirs', c && c.altEmails);
    ok(r.by('uma.mockery@example.com').name === 'Uma Mockery, Jr.' && r.by('vic.sampler@example.com').name === 'Vic "Vee" Sampler', '", Jr." stays a suffix, not a first name; quotes in a name are kept', [r.by('uma.mockery@example.com').name, r.by('vic.sampler@example.com').name]);
    ok(!(r.by('pia.firstrow@example.com').altEmails || []).length && r.by('quin.secondrow@example.com') && r.by('quin.secondrow@example.com').name === 'Quin Secondrow', 'a second address that is the next row\'s own: that is another person, kept apart', [r.by('pia.firstrow@example.com').altEmails, r.by('quin.secondrow@example.com') && r.by('quin.secondrow@example.com').name]);
    ok(r.pre.invalid === 1 && r.pre.invalidSamples[0].name === 'Wren Nomail' && r.by('xan.tollfree@example.com').phone === '(866) 555-2123', 'someone with no address is reported, not added; a toll-free number is kept as written', r.pre.invalidSamples);

    // ---- Outlook, HubSpot ----
    r = await importFile([
      'First Name,Last Name,Company,Job Title,E-mail Address,Business Phone,Mobile Phone,Home City,Home State,Home Postal Code',
      'Yara,Specimen,Example Co,Account Executive,yara.specimen@example.com,(617) 555-2124,(617) 555-2125,Boston,MA,02110',
      'Zed,Sampleton,Example Inc,Sales Rep,zed.sampleton@example.com,,(617) 555-2126,Cambridge,MA,02139',
    ].join('\n'));
    c = r.by('yara.specimen@example.com');
    ok(c && c.location === 'Boston, MA 02110' && c.role === 'Account Executive' && c.company === 'Example Co' && /^\+1617555212[45]$/.test(c.phone), 'Outlook: place, role, company and a phone', c && [c.location, c.role, c.company, c.phone]);
    r = await importFile([
      'Email,First Name,Last Name,Phone Number,City,State/Region,Postal Code,Company Name,Job Title,Contact owner',
      'abe.hubspot@example.com,Abe,Hubspot,512-555-2127,Austin,TX,78701,Example LLC,Closer,Some Owner',
      'bea.hubspot@example.com,Bea,Hubspot,512-555-2128,Dallas,TX,75201,Example LLC,Closer,Some Owner',
    ].join('\n'));
    c = r.by('abe.hubspot@example.com');
    ok(c && c.location === 'Austin, TX 78701' && c.name === 'Abe Hubspot' && c.role === 'Closer' && c.company === 'Example LLC', 'HubSpot: State/Region and Postal Code, and the contact owner is not the name', c && [c.location, c.name]);

    // ---- a semicolon file in French; a file with no header ----
    r = await importFile([
      'Prénom;Nom;Courriel;Téléphone;Ville',
      'Céline;Exemple;celine.exemple@example.com;514-555-2129;Montréal',
      'Éric;Fictif;eric.fictif@example.com;514-555-2130;Laval',
    ].join('\n'));
    c = r.by('celine.exemple@example.com');
    ok(c && c.name === 'Céline Exemple' && c.phone === '+15145552129' && c.location === 'Montréal', 'semicolons, French headers, accents', c && [c.name, c.phone, c.location]);
    r = await importFile([
      'Gus Headerless,gus.headerless@example.com,(617) 555-2131,"Austin, TX"',
      'Hal Headerless,hal.headerless@example.com,(617) 555-2132,"Dallas, TX"',
      'Ida Headerless,ida.headerless@example.com,(617) 555-2133,"Houston, TX"',
    ].join('\n'));
    c = r.by('gus.headerless@example.com');
    ok(r.read.headerless && c && c.name === 'Gus Headerless' && c.phone === '+16175552131' && c.location === 'Austin, TX' && r.commit.added === 3, 'no header at all: every column recognised from what it holds', c && [c.name, c.phone, c.location]);

    // ---- a Wholesale Payments address ----
    r = await importFile([
      'Name,Email,Phone',
      'Team Member,team.member@wholesalepayments.com,(617) 555-2134',
      'Jo Outsider,jo.outsider@example.com,(617) 555-2135',
    ].join('\n'));
    ok(r.pre.own === 1 && r.commit.added === 1 && !r.added.some((x) => /wholesalepayments/i.test(x.email)), 'a Wholesale Payments address is never added (and says so)', r.pre);
  } finally {
    await s.close();
  }
  done();
})().catch(crash);
