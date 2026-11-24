// Amounts here are bookkeeping records of money handled OUTSIDE this product.
// No processor IDs, payment intents, card information, or transfer operations.
export const DUES_KINDS=Object.freeze([
  {id:"charge",label:"Amount owed"},
  {id:"payment",label:"Paid outside app"},
  {id:"credit",label:"Credit or adjustment"},
  {id:"refund",label:"Refund made outside app"}
]);

export function validateDuesEntry({entryId,kind,amount,note=""}) {
  if(typeof entryId!=="string"||!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(entryId))
    throw new Error("Select a valid entry");
  if(!DUES_KINDS.some(x=>x.id===kind))throw new Error("Select the type of record");
  const dollars=String(amount??"").trim();
  if(!/^\d+(?:\.\d{1,2})?$/.test(dollars))throw new Error("Enter a dollar amount with no more than two decimals");
  const [whole,decimal=""]=dollars.split(".");
  const cents=Number(whole)*100+Number(decimal.padEnd(2,"0"));
  if(!Number.isSafeInteger(cents)||cents<1||cents>100000000)
    throw new Error("Enter an amount between $0.01 and $1,000,000");
  if(typeof note!=="string"||note.length>250)throw new Error("Keep the note under 250 characters");
  return Object.freeze({entryId,kind,amountCents:cents,note:note.trim()||null});
}
