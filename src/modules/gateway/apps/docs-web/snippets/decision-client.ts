import { DecisionClient } from '../../../../../packages/decision-client';

const client = new DecisionClient(
  process.env.BASE_URL ?? 'http://127.0.0.1:8790',
  process.env.CLIENT_KEY,
);
const response = await client.decide({
  model: 'default',
  input: 'A customer asks for an invoice refund.',
  questions: [
    {
      name: 'team',
      type: 'choice',
      instructions: 'Choose the team.',
      choices: [
        { value: 'billing', description: 'Invoices and refunds' },
        { value: 'technical', description: 'Bugs and outages' },
      ],
    },
    { name: 'urgent', type: 'predicate', instructions: 'Does this need urgent attention?' },
    {
      name: 'severity',
      type: 'score',
      instructions: 'Rate the severity.',
      levels: [
        { label: 'low', description: 'Routine request' },
        { label: 'high', description: 'Critical incident' },
      ],
    },
  ],
});
console.log(JSON.stringify(response));
