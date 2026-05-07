# Contributions policy/rules
We must follow this to ensure we do not end up with an absolute piece of shit markdown file. Users do not want to need to filter through shit to find help for whatever issue theyre having.<br>
Therefore we have this which users should follow before deciding to contribute to the FAQ.

## Policy
Remember to comment the end of each detail that way it is easier for maintaining and preventing markdown issues.

<details>
  <summary>General FAQ Rules</summary>

  When making an general FAQ post (this means just answering questions like this section as an [example](https://github.com/vxaboveground/Overlord/FAQ#defaults) you should follow the below guide lines:

  Youre required to use `<details><summary></summary></details>` when you're providing support. This goes for any policy to prevent clutter and an needless waste of time. 

  #### Incase of multiple platform support:
  If your FAQ includes supporting multiple platforms you are urged to use a detail list for the initial issue then inside of that you are rquired to have an aditional details list for each platform (1 per platform, win, mac, lin).<br>
  If youre confused you may look at the [Common Issues](https://github.com/vxaboveground/Overlord/FAQ#common-issues) markdown inside of the FAQ README.md, you can also find template code at the very very top of the README which is commented out for ease of use for developers.  
</details>

<hr>

<details>
  <summary>Issue / Bug support</summary>

  When making an Issue support / Bug support FAQ you are **required to provide at least 1 platform fix, explain the why, what and how** to the bug/issues occurance happens, what it effects and how.<br>
  We **require you to provide an indepth, easy to understand explaination on both the issue and the solution/potential solution to the issue when possible.**<br>
  This is so that we have an easier time attempting to help those whom cannot work out how to do it themself and also try to educate the user on the problem. Prevention is better than cure after all.

  However depending on the nature of the issue it may not be needed to define details as we could be talking of an issue that could be todo with clients not connecting after updating.<br>
  <details>
    <summary>Example</summary>

  <br><hr>

  <details>
    <summary>My clients dont connect after updating</summary>
  This is likely due to an update to how the networking/connecting works. These changes can cause instability or break connections with outdated clients.<br>
  It is recommended you download the latest version of docker, keep the current version running (cli <> ser commuinication) then updating the clients to work with the latest<br>
  Once verified all is ported over and working/stable, shutdown the old server and keep the newest one update and migrate other things if needed. 

  </details> 
  </details>
  
</details>


<hr>
<br>

  I ([0xC7R](https://github.com/0xc7r)) will update the policy when needed, if I have any changes to make or whatever else I may want to change.<br>
  ***I heavily urge other developers or contributors to follow these guidelines and rules to keep an clean and concise FAQ***
