(function(){
  'use strict';
  const ESPN_ORIGIN='https://site.api.espn.com';
  const ESPN_PATH='/apis/site/v2/sports/football/nfl/scoreboard';
  const PROXY='https://br-late-hat-b55ygmj4-nflscores.compute.c-7.us-east-2.aws.neon.tech/';
  const nativeFetch=window.fetch.bind(window);

  window.fetch=function(input,init){
    let url;
    try{
      const raw=input instanceof Request?input.url:input;
      url=new URL(raw,window.location.href);
    }catch(_){
      return nativeFetch(input,init);
    }

    if(url.origin===ESPN_ORIGIN&&url.pathname===ESPN_PATH){
      const season=url.searchParams.get('dates');
      const week=url.searchParams.get('week');
      const target=new URL(PROXY);
      if(season)target.searchParams.set('season',season);
      if(week)target.searchParams.set('week',week);
      target.searchParams.set('_',String(Date.now()));
      return nativeFetch(target.toString(),init);
    }

    return nativeFetch(input,init);
  };
})();
