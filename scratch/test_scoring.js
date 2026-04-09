const { scoreMatch, scoreText, scoreDoubleText, scoreTripleText, computeScore } = require('../index.js');

function test() {
    console.log('--- Testing Backend Scoring Functions ---');

    // Test scoreMatch
    console.log('Match (4/4):', scoreMatch({1:'A', 2:'B', 3:'C', 4:'D'}, {1:'A', 2:'B', 3:'C', 4:'D'}, 4) === 4 ? 'PASS' : 'FAIL');
    console.log('Match (3/4):', scoreMatch({1:'A', 2:'B', 3:'C', 4:'D'}, {1:'A', 2:'B', 3:'C', 4:'X'}, 4) === 3 ? 'PASS' : 'FAIL');

    // Test scoreText
    console.log('Text (correct):', scoreText('12.5', '12,5') === 2 ? 'PASS' : 'FAIL');
    console.log('Text (wrong):', scoreText('12.5', '13') === 0 ? 'PASS' : 'FAIL');

    // Test scoreDoubleText
    console.log('DoubleText (2/2):', scoreDoubleText({1:'5', 2:'10'}, {1:'5', 2:'10'}) === 2 ? 'PASS' : 'FAIL');
    console.log('DoubleText (1/2):', scoreDoubleText({1:'5', 2:'10'}, {1:'5', 2:'9'}) === 1 ? 'PASS' : 'FAIL');

    // Test scoreTripleText
    console.log('TripleText (3/3):', scoreTripleText({1:'A', 2:'B', 3:'C'}, {1:'A', 2:'B', 3:'C'}) === 3 ? 'PASS' : 'FAIL');
    console.log('TripleText (2/3):', scoreTripleText({1:'A', 2:'B', 3:'C'}, {1:'A', 2:'B', 3:'X'}) === 2 ? 'PASS' : 'FAIL');

    // Test computeScore
    const answers = { 'q1': 'A', 'q2': { 1:'X', 2:'Y' }, 'sel-e17': 'A' };
    const answerKeys = { 'q1': 'A', 'q2': { 1:'X', 2:'Y' }, 'sel-e17': 'A' };
    const meta = { 
        'q1': { subj: 'ukr', type: 'radio', pairs: 0 },
        'q2': { subj: 'math', type: 'match', pairs: 2 },
        'sel-e17': { subj: 'ukr', type: 'cloze_sub', pairs: 0 }
    };
    const scores = computeScore(answers, answerKeys, meta);
    console.log('ComputeScore (ukr):', scores['ukr'] === 2 ? 'PASS' : 'FAIL');
    console.log('ComputeScore (math):', scores['math'] === 2 ? 'PASS' : 'FAIL');
}

test();
