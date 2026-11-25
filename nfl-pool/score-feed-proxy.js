(function(){
  'use strict';
  const ESPN_ORIGIN='https://site.api.espn.com';
  const ESPN_PATH='/apis/site/v2/sports/football/nfl/scoreboard';
  const PROXY='https://br-late-hat-b55ygmj4-nflscores2.compute.c-7.us-east-2.aws.neon.tech/';
  const nativeFetch=window.fetch.bind(window);

  window.fetch=function(input,init){
    if(input instanceof Request)return nativeFetch(input,init);

    let url;
    try{
      url=new URL(input,window.location.href);
    }catch(_){
      return nativeFetch(input,init);
    }

    if(url.origin===ESPN_ORIGIN&&url.pathname===ESPN_PATH){
      const season=url.searchParams.get('dates');
      const week=url.searchParams.get('week');
      // The isolated acceptance preview reads only the public historical slate used by its fixtures.
      if (window.location.hostname.endsWith('-r88510179-collabs-projects.vercel.app')) {
        if (season !== '2025' || week !== '1') {
          return Promise.reject(new Error('This QA preview serves only the 2025 Week 1 schedule.'));
        }
        return nativeFetch(new URL('/qa-pr44/schedule/2025/1', window.location.origin).toString(), init);
      }
      const target=new URL(PROXY);
      if(season)target.searchParams.set('season',season);
      if(week)target.searchParams.set('week',week);
      target.searchParams.set('_',String(Date.now()));
      return nativeFetch(target.toString(),init);
    }

    return nativeFetch(input,init);
  };
})();
