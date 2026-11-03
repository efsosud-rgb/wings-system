import { configure } from '@testing-library/react';

// The CI runner shares the server with the agents' gates: findBy/waitFor past the 1 s default failed on
// develop (02/11) and on PR #82, and a test of ~2.3 s alone went past 5 s there.
configure({ asyncUtilTimeout: 4_000 });
