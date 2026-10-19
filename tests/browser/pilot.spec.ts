import { test, expect, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { totp } from '../../src/domain/identity';

const password='fictional-acceptance-password-2026';
test('administrator and two participants complete the fictional-credit pilot',async({browser},info)=>{
  const keyboard=info.project.name==='keyboard';
  const touch=info.project.use.hasTouch===true;
  let touchStarts=0;
  const pages:Page[]=[];const errors:string[]=[];
  const options={viewport:info.project.use.viewport,isMobile:info.project.use.isMobile,hasTouch:info.project.use.hasTouch,baseURL:process.env.ACCEPTANCE_ORIGIN,locale:'en-US'};
  const contexts=await Promise.all([browser.newContext(options),browser.newContext(options),browser.newContext(options)]);
  if(touch)for(const context of contexts){
    await context.exposeBinding('recordAcceptanceTouch',()=>{touchStarts++;});
    await context.addInitScript(()=>document.addEventListener('touchstart',()=>{
      void (window as unknown as {recordAcceptanceTouch:()=>Promise<void>}).recordAcceptanceTouch();
    },{passive:true}));
  }
  for(const context of contexts){context.setDefaultTimeout(15000);context.setDefaultNavigationTimeout(15000);}
  const phase=(text:string)=>console.info(`[${info.project.name}] ${text}`);
  const [admin,seller,buyer]=await Promise.all(contexts.map(context=>context.newPage()));
  pages.push(admin,seller,buyer);
  for(const page of pages)page.on('pageerror',error=>errors.push(error.message));
  const handle=(role:string)=>`${info.project.name}_${role}`;
  const panel=(page:Page,heading:string)=>page.locator('section').filter({has:page.getByRole('heading',{name:heading,exact:true})}).last();
  async function reach(target:Locator){
    await expect(target).toBeVisible();
    const visited=new Set<string>();
    for(let i=0;i<300;i++){
      await expect(target).toBeEnabled();
      visited.add(await target.page().evaluate(()=>document.activeElement?.outerHTML.slice(0,200)??'none'));
      if(await target.evaluate(node=>node===document.activeElement))return;
      await target.page().keyboard.press('Tab');
    }
    throw new Error(`Control cannot be reached by keyboard: ${await target.evaluate(node=>node.outerHTML)}; visited: ${[...visited].join(' | ')}`);
  }
  async function click(target:Locator){if(keyboard){await reach(target);await target.page().keyboard.press('Enter');}else if(touch)await target.tap();else await target.click();}
  async function fill(target:Locator,value:string){
    if(keyboard){
      await reach(target);
      if(await target.getAttribute('type')==='datetime-local'){
        for(let i=0;i<7;i++){await target.page().keyboard.press('ArrowUp');if(i===2)await target.page().keyboard.press('ArrowUp');await target.page().keyboard.press('ArrowRight');}
        await target.page().keyboard.press('Tab');
        expect(Date.parse(await target.inputValue())).toBeGreaterThan(Date.now());
      }else{await target.page().keyboard.press('ControlOrMeta+A');await target.page().keyboard.insertText(value);}
    }else await target.fill(value);
  }
  async function select(target:Locator,value:string){
    if(!keyboard){await target.selectOption(value);return;}
    await reach(target);
    const index=await target.evaluate((node,value)=>Array.from((node as HTMLSelectElement).options).filter(o=>!o.disabled).findIndex(o=>o.value===value),value);
    await target.page().keyboard.press('Home');for(let i=0;i<index;i++)await target.page().keyboard.press('ArrowDown');await target.page().keyboard.press('Tab');
    await expect(target).toHaveValue(value);
  }
  async function check(target:Locator){if(keyboard){await reach(target);if(!await target.isChecked())await target.page().keyboard.press('Space');}else if(touch){if(!await target.isChecked())await target.tap();}else await target.check();await expect(target).toBeChecked();}
  async function audit(page:Page){
    expect((await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze()).violations).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1)).toBe(true);
  }
  async function signIn(page:Page,user:string){
    await page.goto('/account');await fill(page.getByLabel('Handle',{exact:true}),user);await fill(page.getByLabel('Password',{exact:true}),password);
    await click(page.getByRole('button',{name:'Sign in',exact:true}));await expect(page.getByRole('heading',{name:user,exact:true})).toBeVisible();
  }
  async function trade(page:Page,action:'mint'|'burn'|'place',quantity:string,side='buy',duration='GTC'){
    const ticket=page.getByRole('form',{name:'Trading ticket'});
    await expect(ticket.getByLabel('Operation')).toBeEnabled();await select(ticket.getByLabel('Operation'),action);
    if(action==='place'){
      await select(ticket.getByLabel('Side'),side);await fill(ticket.getByLabel('Limit price'), '0.25');await select(ticket.getByLabel('Order duration'),duration);
    }
    await fill(ticket.getByLabel(action==='place'?'Number of shares':'Number of complete sets'),quantity);
    await click(ticket.getByRole('button',{name:action==='place'?'Review order':`Review ${action}`}));
    await expect(page.getByRole('region',{name:'Review trading request'})).toBeFocused();
    await click(page.getByRole('button',{name:action==='place'?'Confirm order':`Confirm ${action}`,exact:true}));
  }
  try{
    phase('sign-in, MFA and account creation');
    await admin.goto('/account');await audit(admin);
    if(keyboard){await admin.keyboard.press('Tab');await expect(admin.getByRole('link',{name:'Skip to content'})).toBeFocused();await admin.keyboard.press('Enter');await expect(admin.locator('main')).toBeFocused();}
    await fill(admin.getByLabel('Handle',{exact:true}),handle('admin'));await fill(admin.getByLabel('Password',{exact:true}),'incorrect-password');
    await click(admin.getByRole('button',{name:'Sign in',exact:true}));await expect(admin.getByRole('alert').filter({hasText:'could not be verified'})).toBeFocused();
    await fill(admin.getByLabel('Password',{exact:true}),password);await click(admin.getByRole('button',{name:'Sign in',exact:true}));
    const setup=panel(admin,'Set up your authenticator');await fill(setup.getByLabel('Current password'),password);await click(setup.getByRole('button',{name:'Create setup key'}));
    const secret=await setup.locator('.mfa-key').innerText();await fill(setup.getByLabel('Authenticator code'),totp(secret,Math.floor(Date.now()/30000)));
    await click(setup.getByRole('button',{name:'Enable authenticator'}));await expect(admin.getByText('Your authenticator is enabled.')).toBeVisible();
    await admin.goto('/admin');
    for(const name of ['seller','buyer']){
      const create=panel(admin,'Create participant');await fill(create.getByLabel('Handle'),handle(name));await fill(create.getByLabel('Initial password'),password);
      await click(create.getByRole('button',{name:'Create account'}));await expect(admin.getByText(handle(name),{exact:true}).first()).toBeVisible();
      const credits=panel(admin,'Credit adjustment');await select(credits.getByLabel('Account on this page'),await credits.getByRole('option',{name:handle(name),exact:true}).getAttribute('value')??'');
      await fill(credits.getByLabel('Amount in credits'),'100');await check(credits.getByRole('checkbox'));await click(credits.getByRole('button',{name:'Confirm adjustment'}));
      await expect(credits.getByRole('status')).toContainText('recorded');
    }
    await audit(admin);
    phase('create and publish market');
    await admin.goto('/admin/markets/new');await fill(admin.getByLabel('YES/NO question'),`Will the ${info.project.name} fictional pilot succeed?`);
    await fill(admin.getByLabel('Description',{exact:true}),'A fictional-credit browser acceptance market.');
    await fill(admin.getByLabel('Closing time (UTC)'),'2099-12-31T12:00');
    await fill(admin.getByLabel('Resolution rules'),'Resolve YES for verified test success, NO for verified failure; invalid if the test evidence is unavailable.');
    await fill(admin.getByLabel('Resolution source'),'Fictional browser acceptance record');await click(admin.getByRole('button',{name:'Create draft'}));
    await expect(admin.getByRole('heading',{name:'Edit draft'})).toBeVisible();const marketAdmin=admin.url();
    await click(admin.getByRole('link',{name:'Review publication'}));await check(admin.getByRole('checkbox'));await click(admin.getByRole('button',{name:'Publish market'}));
    await expect(admin.getByRole('heading',{name:'Published terms'})).toBeVisible();
    const marketPath=await admin.getByRole('link',{name:'View public market'}).getAttribute('href');expect(marketPath).toBeTruthy();
    phase('participant sign-in and lost-response recovery');
    await signIn(seller,handle('seller'));await signIn(buyer,handle('buyer'));
    await seller.goto(marketPath!);await buyer.goto(marketPath!);
    // Lose the response AFTER the server commits. Recover through the ordinary UI.
    await seller.route('**/api/trading/mint',async route=>{await route.fetch();await route.abort('failed');},{times:1});
    await trade(seller,'mint','5');await expect(seller.getByRole('region',{name:'Unconfirmed trading request'})).toBeVisible();
    await click(seller.getByRole('button',{name:'Retry same request'}));await expect(seller.getByRole('region',{name:'Unconfirmed trading request'})).toHaveCount(0);
    await expect(seller.getByRole('status').filter({hasText:'Minted'})).toBeVisible();
    // Replaying the lost response must leave exactly one five-set mint.
    const holdings=panel(seller,'Your shares in this market');
    for(const outcome of ['YES','NO'])await expect(holdings.getByRole('row').filter({has:seller.getByRole('rowheader',{name:outcome,exact:true})}).getByRole('cell').first()).toHaveText('5');
    phase('burn, partial fill and cancellation');
    await trade(seller,'burn','1');await expect(seller.getByRole('status').filter({hasText:'Burned'})).toBeVisible();
    await trade(seller,'place','3','sell');await expect(seller.getByText('0 of 3 shares filled; 3 remain open.')).toBeVisible();
    await buyer.reload();await trade(buyer,'place','2','buy','IOC');await expect(buyer.getByRole('status').filter({hasText:'filled'})).toBeVisible();
    await expect(seller.getByText('2 of 3 shares filled; 1 remain open.')).toBeVisible({timeout:20000});
    await click(seller.getByRole('button',{name:'Cancel remaining 1 shares'}));await click(seller.getByRole('button',{name:'Confirm cancellation'}));await expect(seller.getByText('No open orders in this market.')).toBeVisible();
    await audit(seller);
    phase('market pause and resume');
    await admin.goto(marketAdmin);const pause=admin.locator('form').filter({has:admin.getByRole('button',{name:'Pause market'})});await check(pause.getByRole('checkbox'));await click(pause.getByRole('button',{name:'Pause market'}));
    await expect(buyer.getByText('The administrator has paused this market.')).toBeVisible({timeout:20000});await expect(buyer.getByRole('form',{name:'Trading ticket'})).toHaveCount(0);
    const resume=admin.locator('form').filter({has:admin.getByRole('button',{name:'Resume market'})});await check(resume.getByRole('checkbox'));await click(resume.getByRole('button',{name:'Resume market'}));
    await expect(buyer.getByRole('form',{name:'Trading ticket'})).toBeVisible({timeout:20000});
    // Withdrawal reserve/cancel through participant controls, without a real transfer.
    phase('withdrawal reservation and cancellation');
    await seller.goto('/withdrawals');const request=panel(seller,'Request a withdrawal');await fill(request.getByLabel('Amount in credits'),'1');await check(request.getByRole('checkbox'));await click(request.getByRole('button',{name:'Request withdrawal and reserve credits'}));
    const withdrawal=seller.locator('article').filter({has:seller.getByRole('heading',{name:'1.00 credits · requested'})});await expect(withdrawal).toBeVisible();await click(withdrawal.locator('summary').filter({hasText:'Cancel before payment starts'}));
    await fill(withdrawal.getByLabel('Reason'),'Fictional rehearsal cancellation before any payment.');await check(withdrawal.getByRole('checkbox'));await click(withdrawal.getByRole('button',{name:'Cancel request and release credits'}));await expect(seller.getByRole('heading',{name:'1.00 credits · cancelled'})).toBeVisible();
    await audit(seller);
    // Close releases a resting bid; resolve and observe worker receipts in each account.
    phase('close, resolution and private receipts');
    await buyer.goto(marketPath!);await trade(buyer,'place','1','buy');await expect(buyer.getByText('0 of 1 shares filled; 1 remain open.')).toBeVisible();
    const close=admin.locator('form').filter({has:admin.getByRole('button',{name:'Close market'})});await check(close.getByRole('checkbox'));await click(close.getByRole('button',{name:'Close market'}));
    await expect(admin.getByRole('button',{name:'Record final resolution'})).toBeVisible();
    const resolve=admin.locator('form').filter({has:admin.getByRole('button',{name:'Record final resolution'})});await select(resolve.getByLabel('Final result'),'YES');await fill(resolve.getByLabel('Public evidence'),'Verified fictional browser record: the synthetic test succeeded.');await check(resolve.getByRole('checkbox'));await click(resolve.getByRole('button',{name:'Record final resolution'}));
    for(const [page,balance,receipts] of [[seller,'98.50',2],[buyer,'101.50',1]] as const){
      await page.goto('/portfolio');
      await expect(page.locator('#payouts tbody tr')).toHaveCount(receipts,{timeout:20000});
      await expect(page.locator('.balance-grid section').filter({has:page.getByText('Available credits',{exact:true})}).locator('strong')).toHaveText(balance);
      await expect(page.locator('.balance-grid section').filter({has:page.getByText('Reserved credits',{exact:true})}).locator('strong')).toHaveText('0.00');
      await expect(page.locator('#holdings tbody tr')).toHaveCount(0);
      await expect(page.locator('#open-orders')).toContainText('No open orders');
      const paid=page.locator('#payouts tbody tr').filter({has:page.getByRole('cell',{name:'YES / YES',exact:true})});
      await expect(paid.getByRole('cell').nth(3)).toHaveText('2');
      await expect(paid.getByRole('cell').nth(4)).toHaveText('2.00');
      if(page===seller){
        const lost=page.locator('#payouts tbody tr').filter({has:page.getByRole('cell',{name:'NO / YES',exact:true})});
        await expect(lost.getByRole('cell').nth(3)).toHaveText('4');
        await expect(lost.getByRole('cell').nth(4)).toHaveText('0.00');
      }
      await audit(page);
    }
    await seller.goto('/account');await click(seller.getByRole('button',{name:'Sign out all sessions'}));await expect(seller.getByRole('heading',{name:'Sign in',exact:true})).toBeVisible();
    expect(errors).toEqual([]);
    if(touch)expect(touchStarts).toBeGreaterThan(0);
  }finally{for(const page of pages)await page.context().close();}
});
